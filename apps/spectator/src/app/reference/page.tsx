import type { Metadata } from "next";
import { ReferenceResolver } from "@/components/reference-resolver";

export const metadata: Metadata = {
  title: "Universal reference",
  description: "Resolve any permanent After Genesis Observatory Reference ID.",
};

export default function ReferenceResolverPage() {
  return <ReferenceResolver />;
}
