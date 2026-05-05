-- Ruralicos - Monitor de clicks recientes y aprendizaje generado
-- Ajusta interval '24 hours' si quieres mirar otra ventana.

select
  c.id as click_id,
  c.created_at as clicked_at,
  u.id as user_id,
  u.name,
  u.phone,
  u.subscription,
  d.id as digest_id,
  d.fecha as digest_fecha,
  a.id as alerta_id,
  a.fuente,
  a.titulo,
  a.provincias,
  a.sectores,
  a.subsectores,
  a.tipos_alerta,
  c.url_destino
from public.alerta_clicks c
join public.users u on u.id = c.user_id
left join public.digests d on d.id = c.digest_id
join public.alertas a on a.id = c.alerta_id
where c.created_at >= now() - interval '24 hours'
order by c.created_at desc
limit 100;

select
  u.id as user_id,
  u.name,
  count(*) as clicks_24h,
  count(distinct c.alerta_id) as alertas_distintas,
  array_agg(distinct a.fuente) as fuentes,
  array_agg(distinct a.tipos_alerta) as tipos_alerta_raw
from public.alerta_clicks c
join public.users u on u.id = c.user_id
join public.alertas a on a.id = c.alerta_id
where c.created_at >= now() - interval '24 hours'
group by u.id, u.name
order by clicks_24h desc;

select
  m.id as memory_id,
  m.created_at,
  m.user_id,
  u.name,
  m.tipo,
  m.peso_inicial,
  m.incorporado_a_embedding,
  m.alerta_id,
  m.digest_id,
  m.contenido
from public.user_memory m
join public.users u on u.id = m.user_id
where m.created_at >= now() - interval '24 hours'
  and m.contenido ilike 'Hizo click en la alerta:%'
order by m.created_at desc
limit 100;
