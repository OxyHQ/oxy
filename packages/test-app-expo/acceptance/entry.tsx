import '../global.css';
import { registerRootComponent } from 'expo';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { Dialog, useDialogControl, useDialogFrame } from '@oxy.so/bloom/dialog';
import { LinkButton } from '@oxy.so/bloom/button';
import { useRef, useState } from 'react';
import { Button, Pressable, Text, TextInput, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
function Content({ morph }: { morph: boolean }) {
  const [step, setStep] = useState(0);
  const [nativeCount, setNativeCount] = useState(0);
  const [bloomCount, setBloomCount] = useState(0);
  const [geometry, setGeometry] = useState('unread');
  const [bounds, setBounds] = useState('unread');
  const nativeRef = useRef<View>(null);
  useDialogFrame({ key: `touch-${step}`, morph });
  const layout = (event: LayoutChangeEvent) => {
    const { x, y, width, height } = event.nativeEvent.layout;
    setGeometry([x, y, width, height].map(Math.round).join(','));
  };
  return <View onLayout={layout} style={{ padding: 20, gap: 18 }}>
    <Text style={{ fontSize: 28 }}>Owned dialog touch probe</Text>
    <Text>step:{step} morph:{String(morph)}</Text>
    <Text testID="touch-counters">native:{nativeCount} bloom:{bloomCount}</Text>
    <Text>content-layout:{geometry}</Text><Text>native-window:{bounds}</Text>
    <TextInput testID="touch-input" placeholder="Synthetic text only" style={{ borderWidth: 1, padding: 12 }} />
    {step === 0 ? <Button title="Show taller frame" onPress={() => setStep(1)} /> : <>
      <Text style={{ fontSize: 48 }}>Second frame</Text>
      <Text>Only local counters. No authentication, HTTP requests, identity or credentials.</Text>
      <View style={{ height: 180 }}><Text>Measured spacer</Text></View>
      <Pressable ref={nativeRef} testID="touch-native" accessibilityRole="button" onPress={() => setNativeCount(n => n + 1)} style={{ padding: 18, backgroundColor: '#cceeff' }}><Text>Native press counter</Text></Pressable>
      <LinkButton testID="touch-bloom" onPress={() => setBloomCount(n => n + 1)}>Bloom press counter</LinkButton>
      <Button title="Measure native button" onPress={() => nativeRef.current?.measureInWindow((x, y, w, h) => setBounds([x, y, w, h].map(Math.round).join(',')))} />
    </>}
  </View>;
}
function Probe() {
  const control = useDialogControl();
  const [morph, setMorph] = useState(true);
  const [closed, setClosed] = useState(0);
  return <SafeAreaView style={{ flex: 1, padding: 24, gap: 18 }}>
    <Text style={{ fontSize: 24 }}>Isolated native touch diagnostic</Text>
    <Text>installed-bloom:6.2.0 closed:{closed}</Text>
    <Text>No auth provider or network operations.</Text>
    <Button title={`Morph ${morph ? 'enabled' : 'disabled'} (diagnostic)`} onPress={() => setMorph(!morph)} />
    <Button title="Open probe dialog" onPress={() => control.open()} />
    <Dialog control={control} placement="bottom" header={{ title: '' }} dismissOnBackdrop={false} morph={morph} maxWidth={420} contentPadding={0} onClose={() => setClosed(n => n + 1)}>
      <Content morph={morph} />
    </Dialog>
  </SafeAreaView>;
}
function App() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><KeyboardProvider><BloomThemeProvider mode="light"><Probe /></BloomThemeProvider></KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>;
}
registerRootComponent(App);
