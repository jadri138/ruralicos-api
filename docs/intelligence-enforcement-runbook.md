# Runbook de enforcement de inteligencia

## Modos

`DIGEST_FINAL_VALIDATION_MODE` admite:

- `shadow`: audita sin bloquear;
- `critical`: bloquea solo riesgos criticos demostrables;
- `enforce`: aplica toda la decision final.

La variable anterior `DIGEST_FINAL_VALIDATION_ENFORCEMENT=true` sigue siendo
compatible y se interpreta como `enforce` si no existe la variable nueva.

## Secuencia de activacion

1. Aplicar las migraciones aditivas.
2. Mantener `ALERT_PRECLASSIFIER_MODE=observe`.
3. Mantener `DIGEST_FINAL_VALIDATION_MODE=shadow` durante al menos siete dias.
4. Reunir al menos 500 decisiones de `final_validation`.
5. Activar `critical`.
6. Revisar manualmente al menos 100 bloqueos.
7. Activar `enforce` solo con precision de bloqueos igual o superior al 98 % y
   aumento de no-envios inferior al 10 %.

## Metricas

Decisiones observadas:

```sql
select action, reason, count(*)
from public.digest_candidate_decisions
where stage = 'final_validation'
  and created_at >= now() - interval '7 days'
group by action, reason
order by count(*) desc;
```

Volumen minimo:

```sql
select count(*) as decisiones
from public.digest_candidate_decisions
where stage = 'final_validation'
  and created_at >= now() - interval '7 days';
```

No-envios diarios:

```sql
select fecha,
       count(*) filter (where status = 'no_send') as no_send,
       count(*) as intentos,
       round(
         100.0 * count(*) filter (where status = 'no_send')
         / nullif(count(*), 0),
         2
       ) as no_send_pct
from public.digest_attempts
where fecha >= current_date - 14
group by fecha
order by fecha;
```

Motivos criticos:

```sql
select reason, count(*)
from public.digest_candidate_decisions
where stage = 'final_validation'
  and metadata_json ->> 'enforcement_mode' = 'critical'
  and action in ('blocked', 'review_only')
group by reason
order by count(*) desc;
```

La precision se calcula sobre la muestra revisada:

`bloqueos correctamente clasificados / bloqueos revisados`.

## Reversion

Cambiar inmediatamente:

```text
DIGEST_FINAL_VALIDATION_MODE=shadow
```

No hay que revertir migraciones ni borrar decisiones. Para desactivar tambien
la preclasificacion:

```text
ALERT_PRECLASSIFIER_MODE=off
```

Tras revertir, comprobar el siguiente digest y comparar `no_send_pct` con los
siete dias anteriores.
