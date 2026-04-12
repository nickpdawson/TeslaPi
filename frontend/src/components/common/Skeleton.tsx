interface SkeletonProps {
  width?: string;
  height?: string;
  variant?: 'text' | 'rect' | 'circle';
}

export function Skeleton({
  width = '100%',
  height = '16px',
  variant = 'text',
}: SkeletonProps) {
  const borderRadius = variant === 'circle'
    ? '50%'
    : variant === 'text'
      ? 'var(--radius-sm)'
      : 'var(--radius-md)';

  return (
    <div
      class="skeleton"
      style={{
        width,
        height,
        borderRadius,
        display: 'block',
      }}
      aria-hidden="true"
    />
  );
}
