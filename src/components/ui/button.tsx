import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
};

export function Button({ children, className, type = 'button', ...props }: ButtonProps) {
  return (
    <button className={['button', className].filter(Boolean).join(' ')} type={type} {...props}>
      {children}
    </button>
  );
}
