# claude-mods

Mody (pluginy) do Claude Code. Każdy mod to osobny folder.

## model-router

Ocenia każdy prompt przez Haiku i wybiera model dla tury: proste zadania na Haiku, średnie na Sonnet, złożone na Opus. Wymuszenie ręczne: prefiks `!haiku`, `!sonnet` albo `!opus` przed promptem.

Ustawienia modeli są na górze `model-router/hooks/register.tsx` (stałe `MODEL` i `JUDGE`).
