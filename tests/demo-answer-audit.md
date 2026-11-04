# Saved demo answer audit — Nov 4, 2026

These are worked checks of the saved keys, not participant results. Option letters
are deliberately omitted: the reasoning verifies the answer, independent of index.
All Chinese and Spanish glosses are **not yet reviewed by a native-speaking teacher**.

| Passage | Quick check: answers and workings | Immediate recheck: new cases | Passage mini-check |
| --- | --- | --- | --- |
| Linear algebra | Dot product: 2·3 + 1·4 = **10**. Norm: √(3² + 4²) = **5**. Sum: 1² + 2² + 3² = **14**. | Dot product: 1·2 + 3·4 = **14**. Norm: √(6² + 8²) = **10**. Sum: 2 + 4 + 6 + 8 = **20**. | Residual is **perpendicular to u**. Projection: (2,5)·(1,0)=2, divided by 1, times (1,0) gives **(2,0)**. Scaling nonzero u to length 1 **preserves its line**, so projection onto that line is unchanged. |
| Statistics | Independent observations: the second's distribution **need not change because of the first**. Both group means are 10; deviations are −1,0,1 versus −8,0,8, so **B has greater spread**. Respectively pairs a→4 and **b→9**. | **Two separate fair die rolls** support independent observations with the same distribution; copying a roll does not. Both group means are 8; deviations are −1,0,1 versus −4,0,4, so **Y has greater spread**. Respectively pairs **p→mass** and q→speed. | Estimated standard error is **s/√n**. For s=4,n=16: 4/4=1; 10±1.96 gives **8.04 to 11.96**. Increasing n from 25 to 100 changes √n from 5 to 10; standard error **halves**, with s fixed. |
| Chemistry | Bead ratio 2:1 with 4 blue multiplies both parts by 4: **8 red**. CO₂ has **2 oxygen atoms** per molecule. Conserves means the **total token count stays the same**. | Ratio 3:2 with 6 green multiplies by 3: **9 yellow**. NH₃ has **3 hydrogen atoms**. Conserving mass means **mass remains unchanged**. | Change **coefficients**, preserving each formula. Double 2:1:2 to 4:2:4: **4 water molecules**. H₂O₂ has a different atom ratio from H₂O, so changing the subscript **changes the substance**. |
| Physics | Signed sum: +7+(−3)=**+4 N**. N/kg=(kg·m/s²)/kg=**m/s²**. Constant temperature means **held at the same value**. | Signed sum: +9+(−4)=**+5 N**. Force units are **kg × m/s²**. At constant mass, **mass** is fixed. | Net force is the **sum of forces with directions**. (10−4) N / 2 kg = **+3 m/s²**. Acceleration is **velocity change, not current direction**: leftward velocity can coexist with rightward acceleration while the cart slows down. |

Saved bridges use the passage's numbers: 2H₂ + O₂ and 2H₂O each contain
four H and two O atoms; 6:3:6 triples that ratio. The physics passage gives
(8−2) N / 3 kg = 2 m/s². Statistics distinguishes individual-value spread
from the distribution of repeated sample means. Saved teacher lessons are
restricted to their own passage, and their numerical checks use the workings above.

The smoke test audits every stored answer_text/index pair and option-length ratio,
runs every passage in English, Chinese, and Spanish, and checks both full and
all-correct paths. This audit does not establish assessment validity or gloss quality.
