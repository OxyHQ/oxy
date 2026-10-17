import { forwardRef, useImperativeHandle, useRef } from 'react';
import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk';
import { useAuth } from '@oxy.so/services/ui/client';

export interface AliaSupportRef {
  present: () => void;
}

/** The app owns one embedded Alia sheet; Oxy's help entry opens this instance. */
export const AliaSupport = forwardRef<AliaSupportRef>(function AliaSupport(_, ref) {
  const chatRef = useRef<AliaChatSheetRef>(null);
  const { canUsePrivateApi, signIn } = useAuth();
  useImperativeHandle(
    ref,
    () => ({
      present() {
        if (canUsePrivateApi) chatRef.current?.present();
        else void signIn();
      },
    }),
    [canUsePrivateApi, signIn],
  );

  return canUsePrivateApi ? (
    <AliaChatSheet
      ref={chatRef}
      clientContext="The user opened Oxy account Help & Support. Help with Oxy account settings, profile, privacy, security, sessions, and storage. Never ask for passwords, sign-in codes, recovery phrases, or private keys."
      welcomeGreeting="How can I help?"
      welcomeSubtitle="Ask me about your Oxy account."
      welcomeSuggestions={[
        { id: 'security', text: 'How can I secure my account?' },
        { id: 'privacy', text: 'Help me understand my privacy settings' },
        { id: 'storage', text: 'How can I free up storage?' },
      ]}
    />
  ) : null;
});
