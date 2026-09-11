export function BrandIcon({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      className={`app-brand-icon ${className}`.trim()}
      src={`${import.meta.env.BASE_URL}${size <= 32 ? 'favicon.svg' : 'app-icon.svg'}`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
