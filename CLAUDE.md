# kevintracy.info

Personal site, served by **GitHub Pages** from the `main` branch (custom domain in `CNAME`).
Pushing to `main` deploys, usually within about a minute. There is no build step beyond GitHub's
default Jekyll pass.

> This repo and every non-underscore file in it are **public**, including this file.
> Never commit emails, tokens or secrets.

| Path | What |
|---|---|
| `index.html`, `stylesheet.css`, `images/`, `*.pdf` | Homepage: bio, papers, CV, thesis |
| `lift/` | Workout tracker (kevintracy.info/lift). **Read `_lift-api/README.md` before touching it.** |
| `_lift-api/` | Cloudflare Worker + D1 backend for `lift/`, and its full docs. Not published (Jekyll skips `_` folders). |
| `btb/` | Project page: Derivative-Free Multiple Shooting With Blended Trajectory Bundles |
| `cbct/`, `cbct-segmented/` | Browser CBCT scan viewers (generated from another project, "fairy-my-teeth"; the commit messages note the source commit) |
| `data/` | Small data files |

Conventions:
- Plain HTML/CSS/JS, no frameworks or bundlers. Keep pages light.
- Don't add `.nojekyll`; it would publish `_lift-api/`.
- To preview locally, run `python3 -m http.server 8765` from the repo root and open `http://localhost:8765/`.
