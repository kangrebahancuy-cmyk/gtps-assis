import type { ComponentProps } from "react";

export default function Link({ href, ...props }: ComponentProps<"a"> & { href: string }) {
  return <a href={href} {...props} />;
}
