interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled = false }: ToggleProps) {
  return (
    <label class={`toggle ${disabled ? 'toggle--disabled' : ''}`}>
      <input
        type="checkbox"
        class="toggle__input"
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        disabled={disabled}
      />
      <span class={`toggle__track ${checked ? 'toggle__track--on' : ''}`}>
        <span class="toggle__thumb" />
      </span>
      {label && <span class="toggle__label">{label}</span>}
    </label>
  );
}
