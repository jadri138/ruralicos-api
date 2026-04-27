-- Migration: añadir columna duplicado_de a alertas para deduplicación cross-boletín.
-- Ejecutar en Supabase SQL Editor.

BEGIN;

ALTER TABLE public.alertas
  ADD COLUMN IF NOT EXISTS duplicado_de bigint
    REFERENCES public.alertas(id) ON DELETE SET NULL;

-- Índice para consultas inversas (¿quién apunta a este canónico?)
CREATE INDEX IF NOT EXISTS idx_alertas_duplicado_de
  ON public.alertas(duplicado_de)
  WHERE duplicado_de IS NOT NULL;

-- Añadir 'duplicado' como valor válido documentado (solo informativo, no hay CHECK constraint en estado_ia)
-- Los valores posibles de estado_ia son:
--   pendiente_clasificar | pendiente_revision | listo | duplicado

COMMIT;
