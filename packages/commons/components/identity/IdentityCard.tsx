/**
 * Reusable Identity Card Component
 * 
 * A flippable ID card component that displays user identity information.
 * Wraps the OxyID (Ticket) component with FrontSide and BackSide.
 */

import React, { useMemo } from 'react';
import { Ticket as OxyID } from '@/components/OxyID';
import { FrontSide } from '@/components/OxyID/front-side';
import { BackSide } from '@/components/OxyID/back-side';
import { IdQrBack } from '@/components/civic/IdQrBack';
import { shortenKey } from '@/utils/shorten-key';

export interface IdentityCardProps {
  displayName?: string;
  username?: string;
  /** A bare Oxy file id; resolved by Bloom's ImageResolver inside `FrontSide`. */
  avatarId?: string;
  accountCreated?: string;
  publicKey?: string;
  /** Optional QR payload — revealed on the back by a long-press. */
  qrPayload?: string;
  /** Caption under the QR (required when `qrPayload` is set). */
  qrCaption?: string;
  width?: number;
  height?: number;
}

export function IdentityCard({
  displayName,
  username,
  avatarId,
  accountCreated,
  publicKey,
  qrPayload,
  qrCaption,
  width = 240,
  height = 380,
}: IdentityCardProps) {
  // Format public key for FrontSide display (first 8 + last 8 characters).
  const publicKeyShort = useMemo(
    () => (publicKey ? shortenKey(publicKey) : undefined),
    [publicKey],
  );

  return (
    <OxyID
      width={width}
      height={height}
      frontSide={
        <FrontSide
          displayName={displayName}
          username={username}
          avatarId={avatarId}
          accountCreated={accountCreated}
          publicKeyShort={publicKeyShort}
        />
      }
      backSide={
        <BackSide
          publicKey={publicKey}
          displayName={displayName}
          accountCreated={accountCreated}
        />
      }
      qrSide={
        qrPayload ? <IdQrBack payload={qrPayload} caption={qrCaption ?? ''} /> : undefined
      }
    />
  );
}

