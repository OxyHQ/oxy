import { Link, type Href } from 'expo-router';
import { Text } from 'react-native';

interface TextLinkProps {
  href: Href;
  children: string;
  className?: string;
}

/** An in-app link drawn as accent text. */
export function TextLink({
  href,
  children,
  className = 'text-sm text-primary underline',
}: TextLinkProps) {
  return (
    <Link href={href} asChild>
      <Text className={className} accessibilityRole="link">
        {children}
      </Text>
    </Link>
  );
}
