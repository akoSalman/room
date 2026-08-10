import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView,
  Platform, ScrollView, Alert, Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { C } from '../theme';
import { BASE_URL } from '../api';
import { e2eSetup } from '../e2e';

export default function AuthScreen({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function signin(register = false) {
    if (!username.trim() || !password.trim()) {
      Alert.alert('Error', 'Username and password are required.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, register }),
      }).then(r => r.json());

      if (res.error && res.canRegister) {
        // Username is free — confirm before creating a brand-new account.
        // Catch the password-length rule here so the user isn't bounced by the
        // server after confirming (the server enforces the same minimum).
        if (password.length < 8) {
          Alert.alert('Password too short', 'Choose a password of at least 8 characters to create an account.');
          return;
        }
        Alert.alert(
          'Create account?',
          `No account named "${username.trim()}" exists. The username is available — create a new account?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Create account', onPress: () => signin(true) },
          ]
        );
        return;
      }
      if (res.error) { Alert.alert('Error', res.error); return; }
      await AsyncStorage.setItem('token', res.token);
      await AsyncStorage.setItem('username', res.username);
      if (res.avatar) await AsyncStorage.setItem('avatar', res.avatar);
      else await AsyncStorage.removeItem('avatar');
      e2eSetup(password).catch(() => {});
      onLogin();
    } catch {
      Alert.alert('Error', 'Could not connect to server.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.flex}>
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        <Image source={require('../../assets/icon.png')} style={s.logoImg} />
        <Text style={s.title}>ChatRoom</Text>
        <Text style={s.sub}>Sign in or create an account</Text>

        <View style={s.card}>
          <Text style={s.label}>USERNAME</Text>
          <TextInput
            style={s.input} placeholder="Your username" placeholderTextColor={C.muted}
            value={username} onChangeText={setUsername}
            autoCapitalize="none" autoCorrect={false}
            onSubmitEditing={() => {}}
          />
          <Text style={[s.label, { marginTop: 14 }]}>PASSWORD</Text>
          <TextInput
            style={s.input} placeholder="Your password" placeholderTextColor={C.muted}
            value={password} onChangeText={setPassword}
            secureTextEntry onSubmitEditing={() => signin()}
          />
          <Text style={s.hint}>New accounts need at least 8 characters.</Text>
          <TouchableOpacity style={s.btn} onPress={() => signin()} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Continue →</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  container: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  logoImg: { width: 88, height: 88, borderRadius: 22, marginBottom: 12 },
  title: { fontSize: 28, fontWeight: '700', color: C.text, marginBottom: 4 },
  sub: { fontSize: 14, color: C.muted, marginBottom: 32, textAlign: 'center' },
  card: { width: '100%', maxWidth: 380, backgroundColor: C.sidebar, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: C.border },
  label: { fontSize: 11, color: C.muted, fontWeight: '600', letterSpacing: 0.6, marginBottom: 6 },
  input: { backgroundColor: C.inputBg, borderRadius: 10, padding: 12, color: C.text, fontSize: 15, borderWidth: 1, borderColor: C.border, marginBottom: 4 },
  hint: { color: C.muted, fontSize: 12, marginTop: 6, marginBottom: 2 },
  btn: { backgroundColor: C.accent, borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 18 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
