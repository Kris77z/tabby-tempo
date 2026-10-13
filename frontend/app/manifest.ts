import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tabby",
    short_name: "Tabby",
    description: "Reputation you can spend. Hosted Agents that keep working within your budget.",
    start_url: "/",
    display: "standalone",
    background_color: "#f1f0ee",
    theme_color: "#f1f0ee",
    icons: [
      { src: "/brand/tabby/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/tabby/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/tabby/app-icon-512.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/brand/tabby/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
