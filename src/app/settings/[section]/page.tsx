import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SectionContent } from "@/features/settings/section-content";
import { SETTINGS_SECTIONS } from "@/lib/constants";

interface SettingsSectionPageProps {
  params: Promise<{ section: string }>;
}

export const dynamicParams = false;

export function generateStaticParams(): { section: string }[] {
  return SETTINGS_SECTIONS.map((section) => ({ section: section.id }));
}

export async function generateMetadata({
  params,
}: SettingsSectionPageProps): Promise<Metadata> {
  const { section } = await params;
  const match = SETTINGS_SECTIONS.find((s) => s.id === section);
  return { title: match ? `${match.label} · Settings` : "Settings" };
}

export default async function SettingsSectionPage({
  params,
}: SettingsSectionPageProps) {
  const { section } = await params;
  const match = SETTINGS_SECTIONS.find((s) => s.id === section);
  if (!match) notFound();

  return (
    <section aria-labelledby="settings-heading">
      <h1 id="settings-heading" className="text-xl font-semibold tracking-tight">
        {match.label}
      </h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">
        {match.description}
      </p>
      <SectionContent id={match.id} />
    </section>
  );
}
