/** Which hosting service (if any) this process runs on. Kept free of imports so every server module can use it. */

const HOST_MARKERS: readonly [string, string][] = [
  ["VERCEL", "Vercel"],
  ["NETLIFY", "Netlify"],
  ["AWS_LAMBDA_FUNCTION_NAME", "AWS Lambda"],
  ["K_SERVICE", "Cloud Run"],
  ["GTPS_HOSTED", "a hosting service"],
];

/** The name of the hosting platform when this process runs on one, otherwise null. */
export function hostedPlatform(env: Record<string, string | undefined> = process.env): string | null {
  for (const [name, label] of HOST_MARKERS) {
    const value = env[name];
    if (value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false") return label;
  }
  return null;
}
