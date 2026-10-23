import { Text } from '@oxy.so/bloom/typography';
import { Link } from 'expo-router';

/**
 * A translated sentence with `{{name}}` slots filled by external links, so each locale keeps
 * its own word order. The links open the Oxy website in a new tab.
 */
export function LinkedText({
  template,
  links,
  className,
}: {
  template: string;
  links: Record<string, { label: string; href: string }>;
  className?: string;
}) {
  const parts = template.split(/(\{\{\w+\}\})/);
  return (
    <Text className={className}>
      {parts.map((part, index) => {
        const link = links[part.slice(2, -2)];
        if (!part.startsWith('{{') || !link) return part;
        return (
          <Link
            key={index}
            href={link.href as never}
            target="_blank"
            rel="noreferrer"
            accessibilityRole="link"
            className="text-foreground underline"
          >
            {link.label}
          </Link>
        );
      })}
    </Text>
  );
}
