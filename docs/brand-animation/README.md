# README Brand Animation

The renderer reuses the whale, cloud and wordmark from the existing light and dark lockups. It produces transparent, eight-second looping APNGs at 1328 x 480 pixels and 20 frames per second, displayed at 640 pixels wide in the README. Full alpha transparency preserves antialiased edges without GIF's binary transparency. The wordmark stays stationary; the whale dives, rises through moving cloud layers and returns to the original pose.

From the repository root, with Node.js, npm and FFmpeg installed:

```sh
npm --prefix docs/brand-animation ci --workspaces=false
npm --prefix docs/brand-animation run build
```

Outputs:

- [Light animation](../assets/dshcloud-swim.png)
- [Dark animation](../assets/dshcloud-swim-dark.png)

The build checks identical loop endpoints, whale movement, a stationary wordmark and lossless decoded edge pixels, and prints the location of temporary contact sheets for visual inspection. Fonts are resolved from the build machine; the checked-in APNGs do not require fonts on the viewer's device. Original SVG lockups are unchanged and used by the README for reduced-motion preferences in compatible renderers. The older GIF files are legacy assets and are not used by the README.

Adjust `poses` for motion timing and position, and `scene` for cloud movement. These build dependencies are separate from the application workspace.