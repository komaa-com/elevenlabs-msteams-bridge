// Docs site for @komaa/elevenlabs-msteams-bridge, published to GitHub Pages by .github/workflows/docs.yml.
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://komaa-com.github.io",
  base: "/elevenlabs-msteams-bridge",
  integrations: [
    starlight({
      title: "Microsoft Teams Bridge for ElevenLabs Agents",
      description:
        "Put an ElevenLabs Agent on a real Microsoft Teams call: verbatim PCM16k audio relay, barge-in, vision on demand, and call governors, connected through the StandIn media bridge.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/komaa-com/elevenlabs-msteams-bridge",
        },
      ],
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "Getting Started", link: "/getting-started/" },
        { label: "Connecting to StandIn", link: "/connecting-to-standin/" },
        { label: "Architecture", link: "/architecture/" },
        { label: "Configuration Reference", link: "/configuration-reference/" },
        { label: "Library API", link: "/library-api/" },
        { label: "Wire Protocol", link: "/wire-protocol/" },
        { label: "Vision and Tools", link: "/vision-and-tools/" },
        { label: "Governors and Privacy", link: "/governors-and-privacy/" },
        { label: "Troubleshooting", link: "/troubleshooting/" },
        { label: "Contributing", link: "/contributing/" },
      ],
    }),
  ],
});
