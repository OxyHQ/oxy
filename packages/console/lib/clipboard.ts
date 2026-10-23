import { toast } from '@oxy.so/bloom/toast';
import * as Clipboard from 'expo-clipboard';

/** Copies `value` to the clipboard and confirms with a toast. */
export async function copyText(value: string, message: string): Promise<void> {
  await Clipboard.setStringAsync(value);
  toast.success(message);
}
