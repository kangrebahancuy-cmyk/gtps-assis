/** Test stand-in for next/navigation: `push` is reported to the page (the harness shell switches page on it). */
export function useRouter() {
  return {
    push: (href: string) => {
      (window as unknown as { __pushed?: string[] }).__pushed = [...((window as unknown as { __pushed?: string[] }).__pushed ?? []), href];
      window.dispatchEvent(new CustomEvent("stub-push", { detail: href }));
    },
    replace: () => {},
    back: () => {},
    refresh: () => {},
  };
}
export const usePathname = () => "/";
