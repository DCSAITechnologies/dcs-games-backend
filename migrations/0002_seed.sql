-- DCS Games — starter seed (0002)
-- Populates the dcsgames_* schema so the public API returns real content that
-- mirrors the frontend SEED. Idempotent: safe to re-run (ON CONFLICT / NOT EXISTS).
-- Money stays in minor units and DARK. Run AFTER 0001_init.sql.
-- ---------------------------------------------------------------------------

begin;

-- 1) CREATORS (is_creator = true) -------------------------------------------
insert into public.dcsgames_users (username, display_name, is_creator, level, rank_tier, verified_by_atlas, coins, xp)
values
  ('novastudio','NovaStudio',true,57,'mythic','verified',0,142000),
  ('redshift','RedShift',true,49,'legend','verified',0,98000),
  ('pathfinder','PathFinder',true,41,'diamond','pending',0,61000),
  ('cyberforge','CyberForge',true,53,'legend','verified',0,112000),
  ('mythworks','MythWorks',true,44,'diamond','verified',0,72000),
  ('nightowl','NightOwl',true,33,'gold','none',0,40000),
  ('polarstudio','PolarStudio',true,38,'gold','pending',0,55000),
  ('aerogames','AeroGames',true,29,'silver','none',0,31000),
  ('byterealm','ByteRealm',true,47,'legend','verified',0,89000),
  ('emberforge','EmberForge',true,42,'diamond','verified',0,66000),
  ('rustline','RustLine',true,35,'gold','none',0,44000),
  ('storyforge','StoryForge',true,40,'diamond','pending',0,60000),
  ('goldmine','GoldMine',true,46,'legend','verified',0,84000),
  ('vastlands','VastLands',true,34,'gold','none',0,43000),
  ('crewworks','CrewWorks',true,45,'diamond','verified',0,80000),
  ('turbolab','TurboLab',true,37,'gold','pending',0,52000),
  ('fieldking','FieldKing',true,31,'silver','none',0,36000),
  ('logicbox','LogicBox',true,39,'gold','verified',0,58000),
  ('learnlab','LearnLab',true,28,'silver','pending',0,29000),
  ('dailysim','DailySim',true,36,'gold','none',0,49000)
on conflict (username) do nothing;

-- 2) WORLDS (21) — creator_id resolved by username --------------------------
insert into public.dcsgames_worlds
  (slug, title, creator_id, genre, maturity, status, atlas_verified, safety_rating, total_plays, rating_avg, ratings_count)
select v.slug, v.title, u.id, v.genre, v.maturity, 'published', v.verified, v.safety, v.plays, v.rating, v.rc
from (values
  ('blackout-protocol','Blackout Protocol','novastudio','horror','16+',true,96,12400,4.80,3120),
  ('zombie-outbreak','Zombie Outbreak','redshift','survival','16+',true,93,8400,4.70,2210),
  ('lost-expedition','Lost Expedition','pathfinder','adventure','13+',true,90,5100,4.60,1340),
  ('neon-drift-2099','Neon Drift 2099','cyberforge','scifi','13+',true,95,9900,4.90,2680),
  ('realm-of-ash','Realm of Ash','mythworks','fantasy','13+',true,91,6700,4.50,1510),
  ('dead-signal','Dead Signal','nightowl','horror','18+',false,88,3200,4.40,820),
  ('frostbite','Frostbite','polarstudio','survival','13+',true,92,7800,4.60,1900),
  ('skyward-ruins','Skyward Ruins','aerogames','adventure','13+',false,87,4000,4.30,990),
  ('quantum-break-in','Quantum Break-In','byterealm','scifi','13+',false,89,2900,4.70,710),
  ('dragon-hollow','Dragon Hollow','emberforge','fantasy','13+',true,90,5500,4.80,1430),
  ('the-last-ward','The Last Ward','novastudio','horror','16+',true,97,11100,4.90,2950),
  ('wasteland-run','Wasteland Run','rustline','survival','16+',false,86,6000,4.50,1480),
  ('midnight-manor','Midnight Manor','storyforge','roleplay','13+',false,88,7200,4.60,1720),
  ('tycoon-empire','Tycoon Empire','goldmine','tycoon','13+',true,90,9100,4.70,2390),
  ('open-frontier','Open Frontier','vastlands','openworld','13+',false,85,5400,4.50,1290),
  ('co-op-heist','Co-op Heist','crewworks','coop','13+',true,92,8000,4.80,2050),
  ('velocity-gp','Velocity GP','turbolab','racing','13+',false,87,6600,4.60,1610),
  ('arena-legends','Arena Legends','fieldking','sports','13+',false,84,4900,4.40,1180),
  ('mind-maze','Mind Maze','logicbox','puzzle','13+',true,89,3700,4.70,900),
  ('code-quest','Code Quest','learnlab','education','13+',true,93,2800,4.50,640),
  ('sim-city-life','Sim City Life','dailysim','simulator','13+',false,86,5000,4.60,1240)
) as v(slug,title,cr,genre,maturity,verified,safety,plays,rating,rc)
join public.dcsgames_users u on u.username = v.cr
on conflict (slug) do nothing;

-- 3) WORLD LIVE players (~1–3% of plays) ------------------------------------
insert into public.dcsgames_world_live (world_id, live_players)
select w.id, greatest(40, (w.total_plays * 0.02)::int)
from public.dcsgames_worlds w
on conflict (world_id) do nothing;

-- 4) EVENTS ------------------------------------------------------------------
insert into public.dcsgames_events (title, kind, prize_pool, participants, starts_at, ends_at)
select * from (values
  ('Halloween Apocalypse','seasonal',5000000,42000, now() - interval '1 day',  now() + interval '6 days'),
  ('Winter Blackout','seasonal',2800000,28000,      now() - interval '2 days', now() + interval '2 days'),
  ('Crew Wars S4','tournament',1900000,19000,       now(),                     now() + interval '10 days'),
  ('Speedrun Weekend','weekend',900000,9000,        now(),                     now() + interval '2 days')
) as e(title,kind,prize_pool,participants,starts_at,ends_at)
where not exists (select 1 from public.dcsgames_events x where x.title = e.title);

-- 5) MARKETPLACE items (prices in minor units; live = false / DARK) ----------
insert into public.dcsgames_market_items (type, title, creator_id, price_cents, rating_avg, sales_count, atlas_verified, live)
select v.type, v.title, u.id, v.price, v.rating, v.sales, v.verified, false
from (values
  ('world','Haunted Hospital Pack','novastudio',1200,4.80,4100,true),
  ('npc','Zombie NPC Bundle','redshift',450,4.60,8900,true),
  ('asset','Neon City Asset Kit','cyberforge',800,4.90,3300,true),
  ('script','Boss AI Script','mythworks',650,4.70,2100,true),
  ('voice_pack','Survivor Voice Pack','nightowl',300,4.50,5500,false),
  ('ai_agent','Economy Template Pro','byterealm',1500,4.80,1200,true)
) as v(type,title,cr,price,rating,sales,verified)
join public.dcsgames_users u on u.username = v.cr
where not exists (select 1 from public.dcsgames_market_items m where m.title = v.title);

-- 6) PLAYERS + global leaderboard -------------------------------------------
insert into public.dcsgames_users (username, display_name, is_creator, level, rank_tier, xp)
values
  ('shadowbyte','ShadowByte',false,80,'mythic',1200000),
  ('kanyax','KanyaX',false,74,'legend',1100000),
  ('novaprime','NovaPrime',false,71,'legend',980000),
  ('riogrande','RiOgrande',false,66,'diamond',870000),
  ('vexmachine','VexMachine',false,63,'diamond',820000),
  ('skyebound','Skyebound',false,59,'gold',790000),
  ('emberfall','EmberFall',false,55,'gold',740000),
  ('ghostward','GhostWard',false,51,'silver',690000)
on conflict (username) do nothing;

insert into public.dcsgames_leaderboard (scope, user_id, score, season)
select 'global', u.id, v.score, 'S4'
from (values
  ('shadowbyte',1200000),('kanyax',1100000),('novaprime',980000),('riogrande',870000),
  ('vexmachine',820000),('skyebound',790000),('emberfall',740000),('ghostward',690000)
) as v(uname,score)
join public.dcsgames_users u on u.username = v.uname
where not exists (
  select 1 from public.dcsgames_leaderboard lb where lb.user_id = u.id and lb.scope = 'global'
);

-- 7) ATLAS receipts (powers public Atlas feed + atlas/stats) -----------------
insert into public.dcsgames_atlas_receipts (subject_type, subject_id, attestation, attested_by, trust_status)
select 'world', w.id,
       jsonb_build_object('safety_rating', w.safety_rating, 'maturity', w.maturity, 'check','content-scan'),
       'cw7-atlas', 'pre-gate-1'
from public.dcsgames_worlds w
where w.atlas_verified = true
  and not exists (
    select 1 from public.dcsgames_atlas_receipts r
    where r.subject_type='world' and r.subject_id = w.id
  );

insert into public.dcsgames_atlas_receipts (subject_type, subject_id, attestation, attested_by, trust_status)
select 'creator', u.id,
       jsonb_build_object('identity','verified','payout_eligible',false),
       'cw7-atlas', 'pre-gate-1'
from public.dcsgames_users u
where u.is_creator = true and u.verified_by_atlas = 'verified'
  and not exists (
    select 1 from public.dcsgames_atlas_receipts r
    where r.subject_type='creator' and r.subject_id = u.id
  );

commit;

-- Quick check after running:
--   select count(*) from dcsgames_worlds;            -- 21
--   select count(*) from dcsgames_users;             -- 28 (20 creators + 8 players)
--   select players, live, worlds, creators from (select 1) s;  -- via /api/public/stats
