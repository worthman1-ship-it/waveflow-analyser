# Third-party notices

`src/dsp/loudness.ts` and `src/dsp/roughness.ts` contain data tables and algorithms ported
from **MoSQITo** (Modular Sound Quality Integrated Toolbox), Copyright Eomys,
https://github.com/Eomys/MoSQITo, licensed under the Apache License, Version 2.0
(http://www.apache.org/licenses/LICENSE-2.0).

Changes made in the port: rewritten in TypeScript; scalar (per-frame) formulation of the
loudness slope calculation; own third-octave filter bank; roughness frame length rounded
to a power of two and bin frequency taken as k·fs/n.
