import { Link, type Href } from 'expo-router';
import { Text } from 'react-native';

import { parseRichText } from './rich-text-parse';

interface RichTextProps {
  /** A translated string using `code`, **bold** and [link](/href) markup. */
  children: string;
  className?: string;
  selectable?: boolean;
}

/** Prose with inline code, bold and in-app links. External links open in a new tab. */
export function RichText({
  children,
  className = 'text-sm leading-6 text-muted-foreground',
  selectable = true,
}: RichTextProps) {
  return (
    <Text className={className} selectable={selectable}>
      {parseRichText(children).map((token, index) => {
        switch (token.type) {
          case 'code':
            return (
              <Text key={index} className="rounded bg-muted font-mono text-xs text-foreground">
                {` ${token.text} `}
              </Text>
            );
          case 'bold':
            return (
              <Text key={index} className="font-semibold text-foreground">
                {token.text}
              </Text>
            );
          case 'link':
            return (
              <Link
                key={index}
                href={token.href as Href}
                asChild
                target={token.href.startsWith('http') ? '_blank' : undefined}
              >
                <Text className="text-primary underline">{token.text}</Text>
              </Link>
            );
          default:
            return token.text;
        }
      })}
    </Text>
  );
}
