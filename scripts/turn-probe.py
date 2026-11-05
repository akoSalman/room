#!/usr/bin/env python3
"""Ask a TURN server, in its own protocol, whether it is reachable and working.

── WHY THIS EXISTS ──────────────────────────────────────────────────────────

Every TURN measurement today has been made with the wrong instrument, and each
wrong answer cost hours:

  • listener counts stood in for reachability. A bind on a public address does
    not prove a packet arrives, and sockets on 127.0.0.1 do not prove one does
    not. The socket layout follows listening-ip and relay-threads, and a
    changing number was read as though it were an answer;

  • two coturn instances write into one log directory, so "coturn cannot bind"
    was read off a merged stream and attributed to the wrong process;

  • turnutils_uclient was then run under `timeout`, which SIGTERMs it and
    takes its buffered output with it. Three transports reported FAILED with
    not one line of explanation — a verdict indistinguishable from "the client
    was killed before it said anything".

So this speaks STUN and TURN directly over a socket. Every verdict below is a
packet that was sent and a packet that came back, or the absence of one, and
the three outcomes that need different fixes are told apart by name:

    no reply            nothing is listening, or the path is blocked
    error 401 + realm   reachable, TURN alive, credentials are the question
    allocation success  a relay was allocated: this transport works

RFC 5389 (STUN) and RFC 5766 (TURN), long-term credentials.
"""
import hashlib
import hmac
import os
import random
import socket
import struct
import sys

MAGIC = 0x2112A442
BIND_REQUEST = 0x0001
BIND_SUCCESS = 0x0101
ALLOCATE_REQUEST = 0x0003
ALLOCATE_SUCCESS = 0x0103
ALLOCATE_ERROR = 0x0113

ATTR_USERNAME = 0x0006
ATTR_MESSAGE_INTEGRITY = 0x0008
ATTR_ERROR_CODE = 0x0009
ATTR_REALM = 0x0014
ATTR_NONCE = 0x0015
ATTR_REQUESTED_TRANSPORT = 0x0019

# A whole 4-byte boundary, because every attribute is padded to one and a
# miscounted pad shifts everything after it.
def pad(b: bytes) -> bytes:
    return b + b"\x00" * ((4 - len(b) % 4) % 4)


def attr(kind: int, value: bytes) -> bytes:
    return struct.pack("!HH", kind, len(value)) + pad(value)


def message(kind: int, txid: bytes, attrs: bytes) -> bytes:
    return struct.pack("!HHI", kind, len(attrs), MAGIC) + txid + attrs


def parse(data: bytes):
    """(type, transaction id, {attribute: value}) or None if it is not STUN."""
    if len(data) < 20:
        return None
    # The header is 20 bytes: type (2), length (2), magic cookie (4), then a
    # TWELVE-byte transaction id at offset 8. The first version of this read
    # the id from offset 12 and unpacked an 8-byte format out of a 12-byte
    # slice, which raised struct.error on the first reply that ever arrived —
    # so a server answering correctly was reported as unreachable. That is the
    # exact fault this whole file was written to stop happening one layer
    # down, and only the probe's own test caught it.
    kind, length, magic = struct.unpack("!HHI", data[:8])
    if magic != MAGIC:
        return None
    txid = data[8:20]
    body = data[20:20 + length]
    out, i = {}, 0
    while i + 4 <= len(body):
        a_kind, a_len = struct.unpack("!HH", body[i:i + 4])
        value = body[i + 4:i + 4 + a_len]
        # First occurrence wins, as the RFC requires for the attributes here.
        out.setdefault(a_kind, value)
        i += 4 + a_len + ((4 - a_len % 4) % 4)
    return kind, txid, out


def integrity_key(username: str, realm: str, password: str) -> bytes:
    """The long-term credential key: MD5(username:realm:password).

    MD5 is not a choice; RFC 5766 specifies it for this key, and it is a key
    derivation inside the protocol rather than a security decision made here.
    """
    return hashlib.md5(f"{username}:{realm}:{password}".encode()).digest()


def with_integrity(kind: int, txid: bytes, attrs: bytes, key: bytes) -> bytes:
    """Append MESSAGE-INTEGRITY, computed the one way that works.

    The HMAC covers the message with its length field ALREADY counting the 24
    bytes this attribute will occupy. Computing it over the real length is the
    classic way to get a 401 from a server that is working perfectly.
    """
    claimed = len(attrs) + 24
    head = struct.pack("!HHI", kind, claimed, MAGIC) + txid
    mac = hmac.new(key, head + attrs, hashlib.sha1).digest()
    return head + attrs + attr(ATTR_MESSAGE_INTEGRITY, mac)


class Transport:
    """One exchange, over UDP or TCP, with retries that UDP needs and TCP does not."""

    def __init__(self, host: str, port: int, tcp: bool, timeout: float = 3.0):
        self.host, self.port, self.tcp, self.timeout = host, port, tcp, timeout
        self.sock = None
        self.family = None
        self.sockaddr = None

    def __enter__(self):
        kind = socket.SOCK_STREAM if self.tcp else socket.SOCK_DGRAM
        # ── The address family comes from the address ────────────────────
        #
        # Hardcoding AF_INET made an IPv6 host report "UNREACHABLE: address
        # family for hostname not supported", which reads as a verdict about
        # the server and is really a limitation of the probe. One of the two
        # domains resolves to IPv6, so this was not hypothetical: it produced
        # exactly the kind of confident wrong reading this file exists to
        # replace.
        #
        # getaddrinfo also resolves names, so a name and a literal of either
        # family all arrive here the same way.
        info = socket.getaddrinfo(self.host, self.port, socket.AF_UNSPEC, kind)
        if not info:
            raise socket.gaierror(f"no address for {self.host}")
        self.family, _, _, _, self.sockaddr = info[0]
        self.sock = socket.socket(self.family, kind)
        self.sock.settimeout(self.timeout)
        if self.tcp:
            self.sock.connect(self.sockaddr)
        return self

    def __exit__(self, *_):
        try:
            self.sock.close()
        except Exception:
            pass

    def exchange(self, payload: bytes, txid: bytes, tries: int = 3):
        """Send, and return the reply with the matching transaction id."""
        for _ in range(tries):
            try:
                if self.tcp:
                    self.sock.sendall(payload)
                else:
                    # The resolved sockaddr, not (host, port): IPv6 needs a
                    # four-tuple and re-resolving per send is pointless.
                    self.sock.sendto(payload, self.sockaddr)
                # A STUN server may be answering somebody else at the same
                # time; only the reply to THIS request counts.
                for _ in range(4):
                    data = self.sock.recv(2048)
                    got = parse(data)
                    if got and got[1] == txid:
                        return got
            except socket.timeout:
                if self.tcp:
                    break          # a stream that said nothing will not start
            except OSError as e:
                return ("oserror", e)
        return None


def probe(host: str, port: int, tcp: bool, username: str, password: str) -> str:
    label = f"{'tcp' if tcp else 'udp'} {port}"
    txid = bytes(random.getrandbits(8) for _ in range(12))
    try:
        with Transport(host, port, tcp) as t:
            # ── 1. Is anything there at all? ──────────────────────────────
            # A Binding request needs no credentials, so a reply to it
            # separates "blocked or nothing listening" from every other
            # outcome — which is the distinction that has been guessed at all
            # day.
            got = t.exchange(message(BIND_REQUEST, txid, b""), txid)
            if got is None:
                return f"{label:10} UNREACHABLE   no reply to a STUN binding request"
            if isinstance(got, tuple) and got[0] == "oserror":
                return f"{label:10} UNREACHABLE   {got[1]}"
            if got[0] != BIND_SUCCESS:
                return f"{label:10} ODD           binding answered with type 0x{got[0]:04x}"

            # ── 2. Is the TURN service alive behind it? ───────────────────
            # Unauthenticated on purpose: a server with long-term credentials
            # MUST answer 401 and hand back a realm and a nonce. That reply is
            # proof the TURN half is running, and it is what the credentialed
            # attempt needs anyway.
            txid2 = bytes(random.getrandbits(8) for _ in range(12))
            req = attr(ATTR_REQUESTED_TRANSPORT, b"\x11\x00\x00\x00")  # 17 = UDP
            got = t.exchange(message(ALLOCATE_REQUEST, txid2, req), txid2)
            if got is None:
                return (f"{label:10} HALF          STUN answers, TURN allocate does not "
                        f"— the relay is not serving this port")
            if got[0] == ALLOCATE_SUCCESS:
                # Allowed, if the server is configured without authentication.
                return f"{label:10} OK            allocated with no credentials needed"
            realm = got[2].get(ATTR_REALM, b"").decode(errors="replace")
            nonce = got[2].get(ATTR_NONCE, b"")
            err = got[2].get(ATTR_ERROR_CODE, b"")
            code = (err[2] * 100 + err[3]) if len(err) >= 4 else 0
            if code != 401 or not realm or not nonce:
                return f"{label:10} REFUSED       allocate answered {code or 'oddly'}"
            if not username or not password:
                return (f"{label:10} REACHABLE     TURN is alive (401, realm set) but no "
                        f"credentials were given to finish the allocation")

            # ── 3. Can a relay actually be allocated? ─────────────────────
            txid3 = bytes(random.getrandbits(8) for _ in range(12))
            key = integrity_key(username, realm, password)
            attrs = (req
                     + attr(ATTR_USERNAME, username.encode())
                     + attr(ATTR_REALM, realm.encode())
                     + attr(ATTR_NONCE, nonce))
            got = t.exchange(with_integrity(ALLOCATE_REQUEST, txid3, attrs, key), txid3)
            if got is None:
                return f"{label:10} HALF          no answer to the credentialed allocate"
            if got[0] == ALLOCATE_SUCCESS:
                return f"{label:10} OK            relay allocated"
            err = got[2].get(ATTR_ERROR_CODE, b"")
            code = (err[2] * 100 + err[3]) if len(err) >= 4 else 0
            # 401 here, after a correct integrity, means the credentials are
            # wrong — a completely different fix from an unreachable port, and
            # the two have been conflated repeatedly.
            reason = {401: "credentials rejected", 403: "forbidden",
                      437: "allocation mismatch", 486: "quota reached",
                      508: "no relay ports left"}.get(code, f"error {code}")
            return f"{label:10} AUTH/CONFIG   {reason}"
    except socket.gaierror as e:
        return f"{label:10} DNS           {e}"
    except OSError as e:
        return f"{label:10} UNREACHABLE   {e}"


def main() -> int:
    host = sys.argv[1] if len(sys.argv) > 1 else ""
    if not host:
        print("usage: turn-probe.py HOST [port[/tcp] ...]", file=sys.stderr)
        return 2
    # Credentials from the environment, never the command line: an argument is
    # visible in `ps` to every user on the machine.
    username = os.environ.get("TURN_USERNAME", "")
    password = os.environ.get("TURN_PASSWORD", "")
    targets = sys.argv[2:] or ["3478", "3478/tcp", "443"]
    print(f"probing {host} — each line is a packet sent and one received, or not")
    worst = 0
    for spec in targets:
        port, _, proto = spec.partition("/")
        line = probe(host, int(port), proto == "tcp", username, password)
        print("  " + line)
        if " OK " not in line:
            worst = 1
    return worst


if __name__ == "__main__":
    sys.exit(main())
