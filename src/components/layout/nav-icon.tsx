import { BookOpen, Code2, Cpu, Settings, type LucideIcon } from "lucide-react";

import type { NavIconName } from "@/types";

const ICONS: Record<NavIconName, LucideIcon> = {
  book: BookOpen,
  code: Code2,
  cpu: Cpu,
  settings: Settings,
};

interface NavIconProps {
  name: NavIconName;
  className?: string;
}

export function NavIcon({ name, className }: NavIconProps) {
  const Icon = ICONS[name];
  return <Icon className={className} aria-hidden="true" />;
}
