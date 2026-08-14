import React, { useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView,
  Platform, ScrollView, Alert, Image, Pressable,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { BASE_URL } from '../api';
import { e2eSetup } from '../e2e';
import {
  validateUsername, validatePassword, passwordStrength, normalizeUsername,
  STRENGTH_LABELS, PASSWORD_WARNING, USERNAME_MAX,
} from '../credentials';

type Mode = 'signin' | 'register';

export default function AuthScreen({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  // Only show a field's complaint once the user has moved on from it, so the
  // form isn't shouting at someone who has typed two letters so far.
  const [touched, setTouched] = useState<{ u?: boolean; p?: boolean }>({});
  const [serverError, setServerError] = useState('');

  const registering = mode === 'register';

  const userErr = useMemo(() => validateUsername(username), [username]);
  const passErr = useMemo(() => validatePassword(password, username), [password, username]);
  const strength = useMemo(() => passwordStrength(password), [password]);

  // Signing in must never be blocked by the rules — an existing account may
  // predate them, and telling someone their own password is "invalid" when it
  // is simply old would be maddening.
  const blocked = registering && (!!userErr || !!passErr);
  const canSubmit = !loading && username.trim().length > 0 && password.length > 0 && !blocked;

  async function submit() {
    setServerError('');
    setTouched({ u: true, p: true });
    if (!username.trim() || !password) return;
    if (blocked) return;

    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, register: registering }),
      }).then(r => r.json());

      // Signing in to a name that doesn't exist: offer to switch rather than
      // silently creating an account off a typo.
      if (res.error && res.canRegister) {
        setLoading(false);
        Alert.alert(
          'No such account',
          `Nothing is signed up as "${normalizeUsername(username)}". Create it as a new account?`,
          [
            { text: 'Check the name', style: 'cancel' },
            { text: 'Create account', onPress: () => { setMode('register'); setTouched({ u: true, p: true }); } },
          ],
        );
        return;
      }
      if (res.error) { setServerError(res.error); return; }

      await AsyncStorage.setItem('token', res.token);
      await AsyncStorage.setItem('username', res.username);
      if (res.avatar) await AsyncStorage.setItem('avatar', res.avatar);
      else await AsyncStorage.removeItem('avatar');
      e2eSetup(password).catch(() => {});
      onLogin();
    } catch {
      setServerError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  const showUserErr = touched.u && registering && userErr;
  const showPassErr = touched.p && registering && passErr;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.flex}>
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        <Image source={require('../../assets/icon.png')} style={s.logoImg} />
        <Text style={s.title}>ChatRoom</Text>

        {/* Explicit mode switch. The old screen guessed from whether the name
            existed, which meant a typo silently became "create an account?" */}
        <View style={s.tabs}>
          {(['signin', 'register'] as Mode[]).map(m => (
            <TouchableOpacity
              key={m}
              style={[s.tab, mode === m && s.tabActive]}
              onPress={() => { setMode(m); setServerError(''); }}
            >
              <Text style={[s.tabText, mode === m && s.tabTextActive]}>
                {m === 'signin' ? 'Sign in' : 'Create account'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={s.card}>
          {/* ── Username ── */}
          <Text style={s.label}>USERNAME</Text>
          <View style={[s.inputWrap, showUserErr && s.inputWrapBad]}>
            <Ionicons name="at" size={18} color={C.muted} />
            <TextInput
              style={s.input}
              placeholder="yourname"
              placeholderTextColor={C.muted}
              value={username}
              onChangeText={(t) => { setUsername(t.replace(/\s/g, '')); setServerError(''); }}
              onBlur={() => setTouched(v => ({ ...v, u: true }))}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={USERNAME_MAX}
              returnKeyType="next"
            />
            {registering && username.length > 0 && !userErr && (
              <Ionicons name="checkmark-circle" size={19} color={C.online} />
            )}
          </View>
          {showUserErr ? (
            <>
              <Text style={s.err}>{userErr!.en}</Text>
              <Text style={[s.err, s.fa]}>{userErr!.fa}</Text>
            </>
          ) : registering ? (
            <Text style={s.hint}>
              3–20 characters · letters, numbers, dot, underscore · starts with a letter
            </Text>
          ) : null}

          {/* ── Password ── */}
          <Text style={[s.label, { marginTop: 16 }]}>PASSWORD</Text>
          <View style={[s.inputWrap, showPassErr && s.inputWrapBad]}>
            <Ionicons name="lock-closed-outline" size={18} color={C.muted} />
            <TextInput
              style={s.input}
              placeholder="Your password"
              placeholderTextColor={C.muted}
              value={password}
              onChangeText={(t) => { setPassword(t); setServerError(''); }}
              onBlur={() => setTouched(v => ({ ...v, p: true }))}
              secureTextEntry={!showPw}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={submit}
              returnKeyType="go"
            />
            {/* Being able to SEE what you typed prevents most lockouts. */}
            <Pressable onPress={() => setShowPw(v => !v)} hitSlop={10}>
              <Ionicons name={showPw ? 'eye-off-outline' : 'eye-outline'} size={20} color={C.muted} />
            </Pressable>
          </View>

          {registering && password.length > 0 && (
            <View style={s.strengthRow}>
              <View style={s.strengthTrack}>
                <View
                  style={[
                    s.strengthFill,
                    { width: `${(strength / 4) * 100}%`, backgroundColor: strengthColor(strength) },
                  ]}
                />
              </View>
              <Text style={[s.strengthLabel, { color: strengthColor(strength) }]}>
                {STRENGTH_LABELS[strength].en}
              </Text>
            </View>
          )}

          {showPassErr && (
            <>
              <Text style={s.err}>{passErr!.en}</Text>
              <Text style={[s.err, s.fa]}>{passErr!.fa}</Text>
            </>
          )}

          {/* ── The warning that matters most ── */}
          {registering && (
            <View style={s.warnBox}>
              <View style={s.warnHead}>
                <Ionicons name="warning-outline" size={17} color="#f59e0b" />
                <Text style={s.warnTitle}>Keep your password safe</Text>
              </View>
              <Text style={s.warnText}>{PASSWORD_WARNING.en}</Text>
              <Text style={[s.warnText, s.fa, { marginTop: 8 }]}>{PASSWORD_WARNING.fa}</Text>
            </View>
          )}

          {!!serverError && <Text style={s.serverErr}>{serverError}</Text>}

          <TouchableOpacity
            style={[s.btn, !canSubmit && s.btnOff]}
            onPress={submit}
            disabled={!canSubmit}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={s.btnText}>{registering ? 'Create account' : 'Sign in'}</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={s.switchRow}
            onPress={() => { setMode(registering ? 'signin' : 'register'); setServerError(''); }}
          >
            <Text style={s.switchText}>
              {registering ? 'Already have an account? Sign in' : 'New here? Create an account'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function strengthColor(n: number) {
  return ['#ef4444', '#ef4444', '#f59e0b', '#84cc16', '#22c55e'][n] || '#ef4444';
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  container: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 22, paddingVertical: 40 },
  logoImg: { width: 78, height: 78, borderRadius: 20, marginBottom: 10 },
  title: { fontSize: 26, fontWeight: '800', color: C.text, marginBottom: 18 },

  tabs: {
    flexDirection: 'row', backgroundColor: C.inputBg, borderRadius: 12, padding: 4,
    width: '100%', maxWidth: 400, marginBottom: 14,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  tabActive: { backgroundColor: C.accent },
  tabText: { color: C.muted, fontSize: 14, fontWeight: '700' },
  tabTextActive: { color: '#fff' },

  card: {
    width: '100%', maxWidth: 400, backgroundColor: C.sidebar, borderRadius: 18,
    padding: 20, borderWidth: 1, borderColor: C.border,
  },
  label: { fontSize: 11, color: C.muted, fontWeight: '700', letterSpacing: 0.6, marginBottom: 7 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    backgroundColor: C.inputBg, borderRadius: 11, paddingHorizontal: 12,
    borderWidth: 1, borderColor: C.border,
  },
  inputWrapBad: { borderColor: '#ef4444' },
  input: { flex: 1, paddingVertical: 12, color: C.text, fontSize: 15.5 },

  hint: { color: C.muted, fontSize: 11.5, marginTop: 6, lineHeight: 16 },
  err: { color: '#f87171', fontSize: 12, marginTop: 6 },
  fa: { textAlign: 'right', writingDirection: 'rtl' },

  strengthRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 9 },
  strengthTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: C.border, overflow: 'hidden' },
  strengthFill: { height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 11.5, fontWeight: '700', width: 66, textAlign: 'right' },

  warnBox: {
    marginTop: 16, backgroundColor: 'rgba(245,158,11,0.10)', borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(245,158,11,0.45)', padding: 13,
  },
  warnHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 7 },
  warnTitle: { color: '#f59e0b', fontSize: 13.5, fontWeight: '800' },
  warnText: { color: C.text, fontSize: 12.5, lineHeight: 19 },

  serverErr: { color: '#f87171', fontSize: 13, marginTop: 14, textAlign: 'center' },

  btn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 18 },
  btnOff: { opacity: 0.45 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },

  switchRow: { marginTop: 14, alignItems: 'center', paddingVertical: 4 },
  switchText: { color: C.accent, fontSize: 13.5, fontWeight: '600' },
});
