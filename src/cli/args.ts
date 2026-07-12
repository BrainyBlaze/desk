export function assertAllowedOption(
  command: string,
  option: string,
  allowedOptions: ReadonlySet<string>
): void {
  if (!allowedOptions.has(option)) {
    throw new Error(`unknown option ${option} for ${command}`);
  }
}

export function requireOptionValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}
