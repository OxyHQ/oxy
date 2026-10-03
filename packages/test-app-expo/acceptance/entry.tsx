import '../global.css';
import { registerRootComponent } from 'expo';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { Dialog, useDialogControl, useDialogFrame } from '@oxy.so/bloom/dialog';
import { Button as BloomButton, LinkButton } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { InputOtp } from '@oxy.so/bloom/input-otp';
import { Text as BloomText } from '@oxy.so/bloom/typography';
import { useRef, useState } from 'react';
import { Button, Keyboard, Pressable, Text, View } from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import { View as CssView } from 'react-native-css/components';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const footerStyle = { alignSelf: 'center', paddingTop: 10, paddingBottom: 10, marginTop: 12 } as const;
const round = (values: number[]) => values.map(Math.round).join(',');
type EventRecord = { kind: string; target?: string; x?: number; y?: number };
function Content({ morph, autofocus }: { morph: boolean; autofocus: boolean }) {
  const [step, setStep] = useState(0);
  const [code, setCode] = useState('');
  const [pressed, setPressed] = useState(0);
  const [native, setNative] = useState(0);
  const [diagnostic, setDiagnostic] = useState('not-read');
  const records = useRef<EventRecord[]>([]);
  const refs = useRef<Record<string, View | null>>({});
  useDialogFrame({ key: `otp-step-${step}`, morph });
  const record = (kind: string, event?: GestureResponderEvent) => {
    const e = event?.nativeEvent;
    records.current = [...records.current.slice(-19), { kind, ...(e ? { target: e.target, x: Math.round(e.pageX), y: Math.round(e.pageY) } : {}) }];
  };
  const read = () => {
    const entries = Object.entries(refs.current).filter(([, node]) => node);
    const bounds: Record<string, string> = {};
    let left = entries.length;
    for (const [id, node] of entries) node?.measureInWindow((x, y, w, h) => {
      bounds[id] = round([x, y, w, h]);
      if (--left === 0) setDiagnostic(JSON.stringify({ bounds, events: records.current }));
    });
  };
  return <View onStartShouldSetResponderCapture={event => { record('capture-start', event); return false; }} onTouchEnd={event => record('bubble-end', event)}>
    <CssView className="w-full max-w-[448px] self-center gap-6" style={{ paddingHorizontal: 20 }}>
      {step === 0 ? <>
        <BloomText style={{ fontSize: 48, lineHeight: 48, fontWeight: '800' }}>Synthetic identifier</BloomText>
        <BloomButton testID="otp-next" onPress={() => setStep(1)}>Continue to code frame</BloomButton>
      </> : <>
        <View style={{ height: 56 }}><Text>Owned fixture logo spacer</Text></View>
        <BloomText style={{ fontSize: 48, lineHeight: 48, fontWeight: '800' }}>Check your email</BloomText>
        <BloomText style={{ fontSize: 18, lineHeight: 28 }}>If an account matches fixtureperson, we sent it a code and a sign-in link.</BloomText>
        <Field label="Code" multiple description="Only synthetic digits" disabled={false}>
          <InputOtp length={6} type="numeric" value={code} onChange={setCode} autoFocus={autofocus} testID="otp-code" />
        </Field>
        <LinkButton testID="otp-letters" size="sm" linkTone="secondary" style={footerStyle} onPress={() => record('letters-press')}>Does your code have letters?</LinkButton>
        <BloomButton testID="otp-continue" appearance="solid" tone="action" onPress={() => record('continue-press')}>Continue</BloomButton>
        <View style={{ gap: 4 }}>
          <LinkButton testID="otp-resend" size="sm" linkTone="secondary" style={footerStyle} onPress={() => record('resend-press')}>Send a new email</LinkButton>
          <View ref={node => { refs.current.link = node; }} collapsable={false}><LinkButton testID="otp-password" size="sm" linkTone="secondary" style={footerStyle}
            onPressIn={() => record('password-in')} onPressOut={() => record('password-out')}
            onPress={() => { record('password-press'); setPressed(n => n + 1); }}>Use your password instead</LinkButton></View>
          <LinkButton testID="otp-other" size="sm" linkTone="secondary" style={footerStyle} onPress={() => record('other-press')}>Use a different account</LinkButton>
        </View>
        <Pressable ref={node => { refs.current.native = node; }} testID="otp-native" accessibilityRole="button" onPress={() => { record('native-press'); setNative(n => n + 1); }} style={{ padding: 10, alignSelf: 'center' }}><Text>Native sibling control</Text></Pressable>
      </>}
      <Text testID="otp-counters">step:{step} link:{pressed} native:{native} autofocus:{String(autofocus)} morph:{String(morph)}</Text>
      <Button title="Dismiss keyboard" onPress={() => Keyboard.dismiss()} />
      <Button title="Read touch diagnostics" onPress={read} />
      <Text testID="otp-diagnostics" style={{ fontSize: 10 }}>{diagnostic}</Text>
    </CssView>
  </View>;
}
function Probe() {
  const control = useDialogControl();
  const [morph, setMorph] = useState(true);
  const [autofocus, setAutofocus] = useState(true);
  const [closed, setClosed] = useState(0);
  return <SafeAreaView style={{ flex: 1, padding: 24, gap: 18 }}>
    <Text style={{ fontSize: 24 }}>Isolated OTP footer touch probe</Text>
    <Text>Registry Bloom6.2.1; closed:{closed}. No auth, network or credential reads.</Text>
    <Button title={`Morph ${String(morph)}`} onPress={() => setMorph(!morph)} />
    <Button title={`Autofocus ${String(autofocus)}`} onPress={() => setAutofocus(!autofocus)} />
    <Button title="Open OTP touch probe" onPress={() => control.open()} />
    <Dialog control={control} placement="bottom" header={{ title: '' }} dismissOnBackdrop={false} morph={morph} contentPadding={0} onClose={() => setClosed(n => n + 1)}>
      <Content morph={morph} autofocus={autofocus} />
    </Dialog>
  </SafeAreaView>;
}
registerRootComponent(() => <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><KeyboardProvider><BloomThemeProvider mode="light"><Probe /></BloomThemeProvider></KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>);
