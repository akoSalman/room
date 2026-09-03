// The screen a crash draws instead of the app disappearing.
//
// See crashReport.ts for why this exists at all. In short: two crashes were
// reported that I could not reproduce or find by reading, and there is no
// crash-reporting service reachable from where this app is used. A crash that
// leaves something on screen to photograph is worth more than another guess.
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { C } from '../theme';
import { CrashInfo, describeCrash, canContinue, isSameCrash, CRASH_HINT } from '../crashReport';
import { onGlobalCrash } from '../globalCrash';

export function CrashScreen({ info, onDismiss, onRestart }: {
  info: CrashInfo;
  onDismiss: () => void;
  onRestart: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const text = describeCrash(info);
  return (
    <View style={s.screen}>
      <Text style={s.title}>The app hit a problem</Text>
      <Text style={s.hint}>{CRASH_HINT}</Text>
      <ScrollView style={s.box} contentContainerStyle={{ padding: 12 }}>
        <Text style={s.mono} selectable>{text}</Text>
      </ScrollView>
      <TouchableOpacity
        style={s.primary}
        onPress={async () => {
          try { await Clipboard.setStringAsync(text); setCopied(true); } catch {}
        }}
      >
        <Text style={s.primaryText}>{copied ? 'Copied — now paste it in a chat' : 'Copy the details'}</Text>
      </TouchableOpacity>
      {/* Only when going back is actually safe: after a fatal error the
          JavaScript is in an unknown state and pretending otherwise would
          produce a second, more confusing crash. */}
      {canContinue(info) && (
        <TouchableOpacity style={s.ghost} onPress={onDismiss}>
          <Text style={s.ghostText}>Go back</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity style={s.ghost} onPress={onRestart}>
        <Text style={s.ghostText}>Restart the app</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * Catches a render that throws, anywhere below it.
 *
 * Deliberately keeps the FIRST error rather than the newest: an error thrown
 * while this screen is on top of a broken tree would otherwise overwrite the
 * report with itself, and the thing worth reading would be gone.
 */
export class CrashBoundary extends React.Component<
  { children: React.ReactNode; onRestart: () => void },
  { info: CrashInfo | null }
> {
  state: { info: CrashInfo | null } = { info: null };

  componentDidMount() {
    // Errors from outside render — a socket handler, a promise, a timer —
    // arrive here rather than through React.
    onGlobalCrash(info => {
      if (isSameCrash(this.state.info, info)) return;
      this.setState(cur => (cur.info ? cur : { info }));
    });
  }

  componentWillUnmount() { onGlobalCrash(null); }

  static getDerivedStateFromError(err: any) {
    return { info: { message: String(err?.message || err), stack: String(err?.stack || '') } };
  }

  componentDidCatch(err: any, react: { componentStack?: string }) {
    const next: CrashInfo = {
      message: String(err?.message || err),
      stack: String(err?.stack || ''),
      componentStack: react?.componentStack || '',
    };
    if (isSameCrash(this.state.info, next)) return;
    this.setState({ info: next });
  }

  render() {
    if (!this.state.info) return this.props.children as any;
    return (
      <CrashScreen
        info={this.state.info}
        onDismiss={() => this.setState({ info: null })}
        onRestart={this.props.onRestart}
      />
    );
  }
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 60, gap: 12 },
  title: { color: C.text, fontSize: 20, fontWeight: '700' },
  hint: { color: C.muted, fontSize: 13, lineHeight: 19 },
  box: { flex: 1, backgroundColor: 'rgba(128,128,128,0.12)', borderRadius: 10 },
  mono: { color: C.text, fontSize: 12, fontFamily: 'monospace', lineHeight: 18 },
  primary: { backgroundColor: C.accent, borderRadius: 10, padding: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700' },
  ghost: { padding: 12, alignItems: 'center' },
  ghostText: { color: C.muted, fontWeight: '600' },
});

export default CrashBoundary;
