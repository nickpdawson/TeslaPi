import type { ComponentChildren } from 'preact';

interface FormFieldProps {
  label: string;
  helpText?: string;
  error?: string;
  children: ComponentChildren;
  htmlFor?: string;
}

export function FormField({ label, helpText, error, children, htmlFor }: FormFieldProps) {
  return (
    <div class="form-field">
      <label class="form-field__label" for={htmlFor}>
        {label}
      </label>
      <div class={`form-field__control ${error ? 'form-field__control--error' : ''}`}>
        {children}
      </div>
      {error && (
        <p class="form-field__error">{error}</p>
      )}
      {helpText && !error && (
        <p class="form-field__help">{helpText}</p>
      )}
    </div>
  );
}
