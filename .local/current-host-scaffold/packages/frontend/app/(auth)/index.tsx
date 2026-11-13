import { Text, View } from 'react-native';
import { useState } from 'react';
import { Button } from '@oxy.so/bloom/button';
import { Dialog, useDialogControl } from '@oxy.so/bloom/dialog';
import { AppShell } from '@oxy.so/bloom/app-shell';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';

export default function HostProbe() {
  const [document, setDocument] = useState(true);
  const dialog = useDialogControl();
  return <View testID="host-envelope" style={{flex:1}}><AppShell header={null} scroll={document ? 'page' : 'fixed'} contentMaxWidth="none"
    panelLayout={{ mode: 'split', flow: document ? 'document' : 'bounded', panels: [{
      id: 'probe', content: <Screen header={<PageHeader title={document ? 'Document host' : 'Bounded host'} actions={<><Button onPress={() => setDocument(!document)}>{document ? 'Use bounded' : 'Use document'}</Button><Button onPress={() => dialog.open()}>Dialog</Button></>} />}>
        <ScreenScrollView testID="host-content">
          {Array.from({length:80},(_,i)=><Text key={i} style={{padding:16}}>Synthetic row {i+1}</Text>)}
        </ScreenScrollView>
      </Screen>,
    }] }} /><Dialog control={dialog} title="Host dialog" actions={[{label:"Close",color:"cancel"}]} /></View>;
}
