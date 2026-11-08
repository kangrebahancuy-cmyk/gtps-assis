import type { LucideIcon } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface FeatureCardProps {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  status: string;
}

export function FeatureCard({
  href,
  title,
  description,
  icon: Icon,
  status,
}: FeatureCardProps) {
  return (
    <Link
      href={href}
      className="group block rounded-lg transition-colors"
      aria-label={`${title}: ${status}`}
    >
      <Card className="h-full transition-colors group-hover:border-primary/40 group-hover:bg-accent/40">
        <CardHeader>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex size-9 items-center justify-center rounded-md bg-secondary text-foreground">
              <Icon className="size-4" aria-hidden="true" />
            </div>
            <Badge variant="muted">{status}</Badge>
          </div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
