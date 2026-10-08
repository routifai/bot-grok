# Changelog

Notable product changes in Nova. See GitHub Releases for tagged builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- The Muse's face is now a 3D jelly character (Bloop) everywhere it appears, recolored from the
  Muse's identity color and expressive in all four states, drawn by one shared renderer. The flat
  face is still used wherever WebGL isn't available.
- Nova is now a standalone product: the self-update/release-watch machinery that tracked an
  upstream repository has been removed, and remaining references to the project's earlier fork
  history have been cleaned up. See [ADR 0003](docs/adr/0003-nova-is-standalone.md).
