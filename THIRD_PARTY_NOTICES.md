# Third-party notices

`src/dsp/loudness.ts` and `src/dsp/roughness.ts` contain data tables and algorithms ported
from **MoSQITo** (Modular Sound Quality Integrated Toolbox), Copyright Eomys,
https://github.com/Eomys/MoSQITo, licensed under the Apache License, Version 2.0
(http://www.apache.org/licenses/LICENSE-2.0).

Changes made in the port: rewritten in TypeScript; scalar (per-frame) formulation of the
loudness slope calculation; own third-octave filter bank; roughness frame length rounded
to a power of two and bin frequency taken as k·fs/n.

src/dsp/iso532Tables.ts and src/dsp/loudnessTv.ts also follow MoSQITo's time-varying loudness (loudness_zwtv: filter tables, non-linear decay, temporal weighting), Apache-2.0.

src/dsp/sottekHms.ts and src/dsp/roughnessEcma.ts follow ecma418-torch (https://github.com/agrathwohl/ecma418-torch), MIT licence:

  Copyright 2026 Andrew A. Grathwohl

  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  documentation files (the "Software"), to deal in the Software without restriction, including without limitation
  the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
  to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
  copyright notice and this permission notice shall be included in all copies or substantial portions of the
  Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

src/dsp/tonalityEcma.ts is written from the text of ECMA-418-2 (4th ed., 2025) clause 6.2; it reuses the front end above and contains no code from the GPL-licensed implementations.

src/dsp/fluctuationEcma.ts is written from the text of ECMA-418-2 (4th ed., 2025) clause 9.1 and reuses the front end above (and the pchip routine in roughnessEcma.ts).
