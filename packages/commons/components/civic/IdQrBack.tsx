import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Canvas, Group, LinearGradient, RoundedRect, vec } from '@shopify/react-native-skia';
import { useDerivedValue } from 'react-native-reanimated';
import { HolographicLogo } from '@/components/OxyID/holographic-logo';
import { useTilt } from '@/components/OxyID/tilt-context';

interface IdQrBackProps {
  /** The Oxy ID QR payload (`oxycommons://card?did=…&v=1`) to encode. */
  payload: string;
  /** Localized caption shown under the QR (e.g. "Scan to verify with Oxy"). */
  caption: string;
}

// Full-spectrum iridescence, matching the guilloché hologram on the card body.
const IRIDESCENT = ['#ff4d6d', '#ff9e2c', '#ffe14d', '#43e97b', '#22d3ee', '#4f8dff', '#a06bff', '#ff6bd6'];

const QR_SIZE = 150;
const QR_FRAME_PAD = 12;
const QR_FRAME = QR_SIZE + QR_FRAME_PAD * 2;
const QR_RADIUS = 12;

/**
 * Back side of the flippable Oxy ID card: a QR of the user's ID payload, laid
 * out like the front — an issuer header, the QR in a framed "verification zone"
 * with a HOLOGRAPHIC iridescent border that shifts with the tilt (matching the
 * card's hologram), and a footer note — so both faces read as one document.
 *
 * The payload encodes ONLY the DID (no trust data) — a scanner resolves and
 * re-verifies the signed card server-side. The parent `Ticket` already
 * compensates for the 180° flip (`scaleX: -1`) so this reads upright.
 */
export function IdQrBack({ payload, caption }: IdQrBackProps) {
  const { nx, ny, mag } = useTilt();

  // Iridescent frame gradient — SAME tilt-driven band as the card's guilloché
  // hologram: its endpoints slide with the phone's tilt (nx/ny), so the border
  // shimmers exactly like the rest of the hologram. No self-animation.
  const borderStart = useDerivedValue(() =>
    vec(QR_FRAME * (-0.3 + nx.value * 0.6), QR_FRAME * (-0.3 + ny.value * 0.6)),
  );
  const borderEnd = useDerivedValue(() =>
    vec(QR_FRAME * (1.3 + nx.value * 0.6), QR_FRAME * (1.3 + ny.value * 0.6)),
  );
  const borderOpacity = useDerivedValue(() => Math.min(1, 0.6 + mag.value * 0.4));

  return (
    <View style={styles.container}>
      {/* Header — mirrors the front. */}
      <View style={styles.header}>
        <HolographicLogo size={20} />
        <Text style={styles.docType}>VERIFY</Text>
      </View>

      {/* Verification zone. */}
      <View className="flex-1 items-center justify-center gap-space-12">
        <View style={styles.qrFrameWrap}>
          <View style={styles.qrFrame}>
            <QRCode value={payload} size={QR_SIZE} color="#1C1C1E" backgroundColor="transparent" />
          </View>
          <Canvas style={styles.qrBorder} pointerEvents="none">
            <Group opacity={borderOpacity}>
              <RoundedRect
                x={1}
                y={1}
                width={QR_FRAME - 2}
                height={QR_FRAME - 2}
                r={QR_RADIUS}
                style="stroke"
                strokeWidth={2}>
                <LinearGradient start={borderStart} end={borderEnd} colors={IRIDESCENT} />
              </RoundedRect>
            </Group>
          </Canvas>
        </View>
        <Text style={styles.caption} numberOfLines={2}>
          {caption}
        </Text>
      </View>

      {/* Footer note. */}
      <View style={styles.footer}>
        <Text style={styles.footerStrong}>SIGNED · SELF-CUSTODY IDENTITY</Text>
        <Text style={styles.footerNote}>Resolves & verifies on the Oxy network</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 18,
    justifyContent: 'space-between',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.18)',
    paddingBottom: 6,
  },
  docType: {
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.2,
    color: '#6E6E73',
  },
  qrFrameWrap: {
    width: QR_FRAME,
    height: QR_FRAME,
  },
  qrFrame: {
    padding: QR_FRAME_PAD,
    borderRadius: QR_RADIUS,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  qrBorder: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: QR_FRAME,
    height: QR_FRAME,
  },
  caption: {
    color: '#3A3A3C',
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.18)',
    paddingTop: 8,
    gap: 2,
  },
  footerStrong: {
    color: '#2B2B2E',
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  footerNote: {
    color: '#6E6E73',
    fontSize: 9,
    letterSpacing: 0.3,
  },
});
