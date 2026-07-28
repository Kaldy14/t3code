export const DESKTOP_OFFICIAL_PACKAGE_NAME = "t3code";
export const DESKTOP_PI_PACKAGE_NAME = "t3code-pi";

export function isPiDesktopDistribution(input: {
  readonly isPackaged: boolean;
  readonly packageName: string | undefined;
}): boolean {
  return input.isPackaged && input.packageName === DESKTOP_PI_PACKAGE_NAME;
}
