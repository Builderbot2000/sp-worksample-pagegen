import type { VisualArchDoc } from "../observability/types";

export function formatArchDoc(archDoc: VisualArchDoc): string {
  const sectionsText = archDoc.sections
    .map((s) => `  ${s.order}. slug: "${s.slug}" | role: ${s.role}\n     ${s.description}`)
    .join("\n");
  const fixedText =
    archDoc.fixedElements.length > 0 ? archDoc.fixedElements.join("; ") : "None";
  return `Background: ${archDoc.backgroundDescription}
Fixed/sticky elements: ${fixedText}
Sections (in visual order):
${sectionsText}`;
}

/**
 * Insert generated section fragments into the skeleton HTML.
 * Matches each fragment to its shell by data-section-slug and replaces
 * the shell's interior. Unmatched slugs are logged as warnings.
 */
export function assembleSkeleton(
  skeletonHtml: string,
  fragments: { slug: string; fragment: string }[],
): string {
  let html = skeletonHtml;
  const missing: string[] = [];
  for (const { slug, fragment } of fragments) {
    const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match opening tag containing data-section-slug="<slug>", any interior, closing tag.
    // \2 backreference enforces the same tag name on the closing element.
    const re = new RegExp(
      `(<([a-zA-Z][a-zA-Z0-9]*)(?:[^>]*)data-section-slug="${escapedSlug}"(?:[^>]*)>)[\\s\\S]*?(<\\/\\2>)`,
    );
    const next = html.replace(re, (_, open, _tagName, close) => `${open}\n${fragment}\n${close}`);
    if (next === html) {
      missing.push(slug);
    } else {
      html = next;
    }
  }
  if (missing.length > 0) {
    console.warn(`[assemble] No shell found for slug(s): ${missing.join(", ")}`);
  }
  return html;
}

/** Extract the :root CSS custom-property block from skeleton HTML (if present). */
export function extractRootCssVars(html: string): string {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!styleMatch) return "";
  const rootMatch = styleMatch[1].match(/(:root\s*\{[^}]*\})/);
  return rootMatch ? rootMatch[1].trim() : "";
}

/**
 * Extract the opening tag of a section shell from the skeleton HTML.
 * Returns just the opening tag string, e.g. `<section class="bg-[#0a2540] py-24" data-section-slug="hero">`.
 */
export function extractShellTag(skeletonHtml: string, slug: string): string | undefined {
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = skeletonHtml.match(
    new RegExp(`<[a-zA-Z][a-zA-Z0-9]*(?:[^>]*)data-section-slug="${escapedSlug}"(?:[^>]*)>`),
  );
  return match?.[0];
}

/** Wrap a filled fragment inside its shell opening tag to give neighbours real rendered HTML. */
export function assembleNeighbour(shellTag: string, fragment: string): string {
  const tagName = shellTag.match(/^<([a-zA-Z][a-zA-Z0-9]*)/)?.[1] ?? "div";
  return `${shellTag}\n${fragment}\n</${tagName}>`;
}
