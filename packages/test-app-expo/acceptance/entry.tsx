import '../global.css';
import { registerRootComponent } from 'expo';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { useDialogFrame, useDialogHeader } from '@oxy.so/bloom/dialog';
import { SurfaceProvider, surfaces } from '@oxy.so/bloom/surfaces';
import { Button as BloomButton, LinkButton } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { InputOtp } from '@oxy.so/bloom/input-otp';
import { Divider } from '@oxy.so/bloom/divider';
import { TextField, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { Text as BloomText } from '@oxy.so/bloom/typography';
import { useRef, useState } from 'react';
import { Button, Pressable, Text, View } from 'react-native';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { View as CssView } from 'react-native-css/components';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const footerStyle = { alignSelf: 'center', paddingTop: 10, paddingBottom: 10, marginTop: 12 } as const;
type RecordEntry = { kind: string; target?: string; x?: number; y?: number; width?: number; height?: number };
type RecordFn = (entry: RecordEntry) => void;
function Header({ title, description }: { title: string; description?: string }) {
  return <CssView className="gap-6">
    <View style={{ height: 56, width: 56 }}><Text style={{ fontSize: 40 }}>O</Text></View>
    <CssView className="max-w-[90%] gap-2">
      <BloomText style={{ fontSize: 48, lineHeight: 48, fontWeight: '800', letterSpacing: -1.2 }}>{title}</BloomText>
      {description ? <BloomText style={{ fontSize: 18, lineHeight: 28 }}>{description}</BloomText> : null}
    </CssView>
  </CssView>;
}
function Content({ nativeControl, capture, record }: { nativeControl: boolean; capture: boolean; record: RecordFn }) {
  const [step, setStep] = useState<'identifier' | 'code' | 'password'>('identifier');
  const [code, setCode] = useState('');
  const [identifier, setIdentifier] = useState('fixtureperson001');
  // AUTH's local sign-in step does not alter SurfaceScreen's route/step/width key.
  useDialogFrame({ key: 'AccountDialog#0#', morph: true });
  useDialogHeader({ largeTitle: true });
  const eventRecord = (kind: string, event: GestureResponderEvent) => {
    const e = event.nativeEvent; record({ kind, target: e.target, x: Math.round(e.pageX), y: Math.round(e.pageY) });
  };
  const layout = (kind: string, event: LayoutChangeEvent) => {
    const { x, y, width, height } = event.nativeEvent.layout;
    record({ kind, x, y, width, height });
  };
  const password = () => { record({ kind: 'password-press' }); setStep('password'); };
  const linkProps = {
    testID: 'exact-password', size: 'sm', linkTone: 'secondary', style: footerStyle,
    onPressIn: () => record({ kind: 'password-in' }), onPressOut: () => record({ kind: 'password-out' }), onPress: password,
    onLayout: (event: LayoutChangeEvent) => layout('password-layout', event),
  } as const;
  return <View style={{ paddingTop: 4, paddingBottom: 20, paddingHorizontal: 20 }}
    onLayout={event => layout('body-layout', event)}
    {...(capture ? { onStartShouldSetResponderCapture: (event: GestureResponderEvent) => { eventRecord('capture-start', event); return false; }, onTouchEnd: (event: GestureResponderEvent) => eventRecord('bubble-end', event) } : {})}>
    <CssView className="w-full max-w-[448px] self-center gap-6">
      {step === 'identifier' ? <>
        <Header title="Sign in" description="Continue with your Oxy account." />
        <View style={{ gap: 12 }}><BloomButton size="lg" appearance="outline" tone="neutral" fullWidth onPress={() => record({ kind: 'commons-fixture-noop' })}>Continue with Oxy</BloomButton><Divider /></View>
        <View style={{ gap: 12 }}>
          <View style={{ gap: 8 }}><TextFieldLabel>Email or username</TextFieldLabel><TextField radius={999}><TextFieldInput testID="exact-identifier" label="Email or username" value={identifier} onValueChange={setIdentifier} autoCapitalize="none" autoCorrect={false} autoFocus={false} /></TextField></View>
          <BloomText style={{ fontSize: 14, lineHeight: 20 }}>Don't have an account? Create account</BloomText>
          <BloomButton testID="exact-next" appearance="solid" tone="action" size="lg" fullWidth onPress={() => setStep('code')}>Continue</BloomButton>
        </View>
        <BloomText style={{ fontSize: 14, lineHeight: 20, textAlign: 'center', paddingHorizontal: 24 }}>By continuing, you agree to our Terms of Service and Privacy Policy.</BloomText>
      </> : step === 'code' ? <>
        <Header title="Check your email" description={`If an account matches ${identifier}, we sent it a code and a sign-in link.`} />
        <Field label="Code" multiple description="Enter the code from your email." disabled={false}><InputOtp length={6} type="numeric" value={code} onChange={setCode} autoFocus testID="exact-code" /></Field>
        <LinkButton testID="exact-letters" size="sm" linkTone="secondary" style={footerStyle} onPress={() => record({ kind: 'letters-press' })}>Does your code have letters?</LinkButton>
        <BloomButton testID="exact-continue" appearance="solid" tone="action" size="lg" fullWidth onPress={() => record({ kind: 'continue-press' })}>Continue</BloomButton>
        <View style={{ gap: 4 }}>
          <LinkButton testID="exact-resend" size="sm" linkTone="secondary" style={footerStyle} onPress={() => record({ kind: 'resend-press' })}>Send a new email</LinkButton>
          {nativeControl ? <Pressable testID="exact-password" accessibilityRole="button" style={footerStyle} onPress={password} onPressIn={linkProps.onPressIn} onPressOut={linkProps.onPressOut} onLayout={linkProps.onLayout}><BloomText variant="body-medium">Use your password instead</BloomText></Pressable> : <LinkButton {...linkProps}>Use your password instead</LinkButton>}
          <LinkButton testID="exact-other" size="sm" linkTone="secondary" style={footerStyle} onPress={() => setStep('identifier')}>Use a different account</LinkButton>
        </View>
      </> : <>
        <Header title="Enter your password" description={identifier} />
        <Text testID="exact-passed">Password link touch received. No password or network operation.</Text>
      </>}
    </CssView>
  </View>;
}
function Probe() {
  const [nativeControl, setNativeControl] = useState(false);
  const [capture, setCapture] = useState(true);
  const [diagnostic, setDiagnostic] = useState('not-read');
  const records = useRef<RecordEntry[]>([]);
  const record: RecordFn = entry => { records.current = [...records.current.slice(-39), entry]; };
  const open = () => {
    records.current = [];
    const presented = surfaces.present(() => <Content nativeControl={nativeControl} capture={capture} record={record} />, { placement: { base: 'bottom', md: 'center' }, header: { largeTitle: true }, dismissOnBackdrop: false, maxWidth: 420, maxHeightRatio: 0.9, contentPadding: 0, scrollable: true, morph: true });
    void presented.then(() => setDiagnostic(JSON.stringify(records.current)));
  };
  return <SafeAreaView style={{ flex: 1, padding: 24, gap: 18 }}>
    <Text style={{ fontSize: 24 }}>Stable AUTH frame touch probe</Text>
    <Text>Bloom6.2.1 registry. Synthetic layout only; no auth, requests or credential reads.</Text>
    <Button title={`Native control ${String(nativeControl)}`} onPress={() => setNativeControl(!nativeControl)} />
    <Button title={`Event capture ${String(capture)}`} onPress={() => setCapture(!capture)} />
    <Button title="Open stable AUTH frame" onPress={open} />
    <Text testID="exact-diagnostics" style={{ fontSize: 10 }}>{diagnostic}</Text>
  </SafeAreaView>;
}
registerRootComponent(() => <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><KeyboardProvider><BloomThemeProvider mode="light"><SurfaceProvider><Probe /></SurfaceProvider></BloomThemeProvider></KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>);
