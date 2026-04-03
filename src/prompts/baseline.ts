export const BASELINE_SYSTEM = `You are a helpful assistant that generates HTML pages from source HTML.`;

export function buildBaselineUserContent(params: { url: string; truncatedHtml: string }): string {
  const { url, truncatedHtml } = params;
  return `Create a single-file HTML page that recreates this page's content and visual design using Tailwind CSS (via CDN script tag). 
        
The page MUST:

- Be a complete, self-contained HTML file
- Use the Tailwind CSS CDN (<script src="https://cdn.tailwindcss.com"></script>)
- Faithfully reproduce the layout, content, and visual style of the source page
- Be responsive and well-structured

Use descriptive kebab-case filename based on the source page's title or domain.

Here is the HTML source of a webpage at ${url}:

<source_html>
${truncatedHtml}
</source_html>`;
}
