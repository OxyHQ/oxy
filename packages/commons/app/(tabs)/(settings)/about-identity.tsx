import { Redirect } from 'expo-router';

export default function NativeOnlyWeb() {
  return <Redirect href="/" />;
}
