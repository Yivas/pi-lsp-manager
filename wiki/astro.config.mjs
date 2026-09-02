import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://yivas.github.io",
  base: "/pi-lsp-manager",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "pi-lsp-manager",
      description: "Policy-controlled language server management for Pi.",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/Yivas/pi-lsp-manager"
        }
      ],
      editLink: {
        baseUrl: "https://github.com/Yivas/pi-lsp-manager/edit/main/wiki/"
      },
      sidebar: [
        { slug: "index" },
        {
          label: "Start here",
          items: [
            { slug: "start/install" },
            { slug: "start/first-diagnostics" }
          ]
        },
        {
          label: "Guides",
          items: [
            { slug: "guides/batch-diagnostics" },
            { slug: "guides/source-actions" },
            { slug: "guides/manual-routes" }
          ]
        },
        {
          label: "Reference",
          items: [
            { slug: "reference/tools-and-commands" },
            { slug: "reference/configuration" },
            { slug: "reference/servers" }
          ]
        },
        {
          label: "Operations",
          items: [
            { slug: "operations/security" },
            { slug: "operations/troubleshooting" },
            { slug: "operations/compatibility" }
          ]
        }
      ]
    })
  ]
});
