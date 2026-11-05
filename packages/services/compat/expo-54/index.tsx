import { registerRootComponent } from 'expo';
import { Text } from 'react-native';
import { OxyProvider, useAuth } from '@oxy.so/services';

function SessionState() {
  const { isAuthResolved, isAuthenticated } = useAuth();
  return <Text>{isAuthResolved ? (isAuthenticated ? 'signed in' : 'signed out') : 'booting'}</Text>;
}

function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so" clientId="oxy_dk_services_expo_54">
      <SessionState />
    </OxyProvider>
  );
}

registerRootComponent(App);
