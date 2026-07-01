import AsyncStorage from '@react-native-async-storage/async-storage';
import { io, Socket } from 'socket.io-client';

export const BASE_URL = 'https://chat.akosalman.com';

export async function getToken() {
  return AsyncStorage.getItem('token');
}
export async function getUsername() {
  return AsyncStorage.getItem('username');
}

export async function setAuth(token: string, username: string) {
  await AsyncStorage.setItem('token', token);
  await AsyncStorage.setItem('username', username);
}

export async function getUserId(): Promise<number | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.id ?? null;
  } catch { return null; }
}

export async function apiFetch(path: string, method = 'GET', body?: object) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

let socket: Socket | null = null;

export async function getSocket(): Promise<Socket> {
  if (socket?.connected) return socket;
  const token = await getToken();
  socket = io(BASE_URL, { auth: { token }, transports: ['websocket'] });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
