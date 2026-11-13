-- One Sky: hardening after the security review.
--
--  1. Places come from a server-side table keyed by IANA zone; client place text is ignored,
--     positions must sit inside the jitter box of the place, zones are computed here.
--  2. Growth limits: wave budget, per-uid and global thread limits, global lantern ceiling,
--     tighter pruning, anonymous users pruned after 30 days.
--  3. Reports: 5 per day, auto-hide breaker, no budget spent on lanterns that cannot be reported.
--  4. Text screen: NFKC, invisible characters, stacked combining marks, un-anchored strong stems.
--  5. search_path = public, pg_temp everywhere; future functions not exposed by default.
--
-- Note on uids: tables never expose uids to clients (column grants), but the realtime presence
-- key on channel `sky` IS the auth uid and every connected client can see it. Nothing here treats
-- a uid as a secret.

-- ───────────────────────────── places ─────────────────────────────
-- Generated from src/lib/tzdata.ts (RAW_PLACES + COUNTRIES, IANA tzdata 2026f): 418 rows.
-- Must be regenerated in a new migration whenever scripts/gen-tz.py regenerates that file.

create table public.places (
  tz      text primary key,
  city    text not null,
  country text not null,
  lat     real not null,
  lon     real not null
);
alter table public.places enable row level security;
revoke all on public.places from public, anon, authenticated;

insert into public.places (tz, city, country, lat, lon) values
  ('Africa/Abidjan', 'Abidjan', 'Côte d’Ivoire', 5.32, -4.03),
  ('Africa/Accra', 'Accra', 'Ghana', 5.55, -0.22),
  ('Africa/Addis_Ababa', 'Addis Ababa', 'Ethiopia', 9.03, 38.7),
  ('Africa/Algiers', 'Algiers', 'Algeria', 36.78, 3.05),
  ('Africa/Asmara', 'Asmara', 'Eritrea', 15.33, 38.88),
  ('Africa/Bamako', 'Bamako', 'Mali', 12.65, -8),
  ('Africa/Bangui', 'Bangui', 'Central African Rep.', 4.37, 18.58),
  ('Africa/Banjul', 'Banjul', 'Gambia', 13.47, -16.65),
  ('Africa/Bissau', 'Bissau', 'Guinea-Bissau', 11.85, -15.58),
  ('Africa/Blantyre', 'Blantyre', 'Malawi', -15.78, 35),
  ('Africa/Brazzaville', 'Brazzaville', 'Republic of the Congo', -4.27, 15.28),
  ('Africa/Bujumbura', 'Bujumbura', 'Burundi', -3.38, 29.37),
  ('Africa/Cairo', 'Cairo', 'Egypt', 30.05, 31.25),
  ('Africa/Casablanca', 'Casablanca', 'Morocco', 33.65, -7.58),
  ('Africa/Ceuta', 'Ceuta', 'Spain', 35.88, -5.32),
  ('Africa/Conakry', 'Conakry', 'Guinea', 9.52, -13.72),
  ('Africa/Dakar', 'Dakar', 'Senegal', 14.67, -17.43),
  ('Africa/Dar_es_Salaam', 'Dar es Salaam', 'Tanzania', -6.8, 39.28),
  ('Africa/Djibouti', 'Djibouti', 'Djibouti', 11.6, 43.15),
  ('Africa/Douala', 'Douala', 'Cameroon', 4.05, 9.7),
  ('Africa/El_Aaiun', 'Laayoune', 'Western Sahara', 27.15, -13.2),
  ('Africa/Freetown', 'Freetown', 'Sierra Leone', 8.5, -13.25),
  ('Africa/Gaborone', 'Gaborone', 'Botswana', -24.65, 25.92),
  ('Africa/Harare', 'Harare', 'Zimbabwe', -17.83, 31.05),
  ('Africa/Johannesburg', 'Johannesburg', 'South Africa', -26.25, 28),
  ('Africa/Juba', 'Juba', 'South Sudan', 4.85, 31.62),
  ('Africa/Kampala', 'Kampala', 'Uganda', 0.32, 32.42),
  ('Africa/Khartoum', 'Khartoum', 'Sudan', 15.6, 32.53),
  ('Africa/Kigali', 'Kigali', 'Rwanda', -1.95, 30.07),
  ('Africa/Kinshasa', 'Kinshasa', 'DR Congo', -4.3, 15.3),
  ('Africa/Lagos', 'Lagos', 'Nigeria', 6.45, 3.4),
  ('Africa/Libreville', 'Libreville', 'Gabon', 0.38, 9.45),
  ('Africa/Lome', 'Lomé', 'Togo', 6.13, 1.22),
  ('Africa/Luanda', 'Luanda', 'Angola', -8.8, 13.23),
  ('Africa/Lubumbashi', 'Lubumbashi', 'DR Congo', -11.67, 27.47),
  ('Africa/Lusaka', 'Lusaka', 'Zambia', -15.42, 28.28),
  ('Africa/Malabo', 'Malabo', 'Equatorial Guinea', 3.75, 8.78),
  ('Africa/Maputo', 'Maputo', 'Mozambique', -25.97, 32.58),
  ('Africa/Maseru', 'Maseru', 'Lesotho', -29.47, 27.5),
  ('Africa/Mbabane', 'Mbabane', 'Eswatini', -26.3, 31.1),
  ('Africa/Mogadishu', 'Mogadishu', 'Somalia', 2.07, 45.37),
  ('Africa/Monrovia', 'Monrovia', 'Liberia', 6.3, -10.78),
  ('Africa/Nairobi', 'Nairobi', 'Kenya', -1.28, 36.82),
  ('Africa/Ndjamena', 'N''Djamena', 'Chad', 12.12, 15.05),
  ('Africa/Niamey', 'Niamey', 'Niger', 13.52, 2.12),
  ('Africa/Nouakchott', 'Nouakchott', 'Mauritania', 18.1, -15.95),
  ('Africa/Ouagadougou', 'Ouagadougou', 'Burkina Faso', 12.37, -1.52),
  ('Africa/Porto-Novo', 'Porto-Novo', 'Benin', 6.48, 2.62),
  ('Africa/Sao_Tome', 'São Tomé', 'São Tomé & Príncipe', 0.33, 6.73),
  ('Africa/Tripoli', 'Tripoli', 'Libya', 32.9, 13.18),
  ('Africa/Tunis', 'Tunis', 'Tunisia', 36.8, 10.18),
  ('Africa/Windhoek', 'Windhoek', 'Namibia', -22.57, 17.1),
  ('America/Adak', 'Adak', 'United States', 51.88, -176.66),
  ('America/Anchorage', 'Anchorage', 'United States', 61.22, -149.9),
  ('America/Anguilla', 'The Valley', 'Anguilla', 18.2, -63.07),
  ('America/Antigua', 'St. John''s', 'Antigua & Barbuda', 17.05, -61.8),
  ('America/Araguaina', 'Araguaína', 'Brazil', -7.2, -48.2),
  ('America/Argentina/Buenos_Aires', 'Buenos Aires', 'Argentina', -34.6, -58.45),
  ('America/Argentina/Catamarca', 'Catamarca', 'Argentina', -28.47, -65.78),
  ('America/Argentina/Cordoba', 'Córdoba', 'Argentina', -31.4, -64.18),
  ('America/Argentina/Jujuy', 'Jujuy', 'Argentina', -24.18, -65.3),
  ('America/Argentina/La_Rioja', 'La Rioja', 'Argentina', -29.43, -66.85),
  ('America/Argentina/Mendoza', 'Mendoza', 'Argentina', -32.88, -68.82),
  ('America/Argentina/Rio_Gallegos', 'Río Gallegos', 'Argentina', -51.63, -69.22),
  ('America/Argentina/Salta', 'Salta', 'Argentina', -24.78, -65.42),
  ('America/Argentina/San_Juan', 'San Juan', 'Argentina', -31.53, -68.52),
  ('America/Argentina/San_Luis', 'San Luis', 'Argentina', -33.32, -66.35),
  ('America/Argentina/Tucuman', 'Tucumán', 'Argentina', -26.82, -65.22),
  ('America/Argentina/Ushuaia', 'Ushuaia', 'Argentina', -54.8, -68.3),
  ('America/Aruba', 'Oranjestad', 'Aruba', 12.5, -69.97),
  ('America/Asuncion', 'Asunción', 'Paraguay', -25.27, -57.67),
  ('America/Atikokan', 'Atikokan', 'Canada', 48.76, -91.62),
  ('America/Bahia', 'Salvador', 'Brazil', -12.98, -38.52),
  ('America/Bahia_Banderas', 'Bahía de Banderas', 'Mexico', 20.8, -105.25),
  ('America/Barbados', 'Bridgetown', 'Barbados', 13.1, -59.62),
  ('America/Belem', 'Belém', 'Brazil', -1.45, -48.48),
  ('America/Belize', 'Belize City', 'Belize', 17.5, -88.2),
  ('America/Blanc-Sablon', 'Blanc-Sablon', 'Canada', 51.42, -57.12),
  ('America/Boa_Vista', 'Boa Vista', 'Brazil', 2.82, -60.67),
  ('America/Bogota', 'Bogotá', 'Colombia', 4.6, -74.08),
  ('America/Boise', 'Boise', 'United States', 43.61, -116.2),
  ('America/Cambridge_Bay', 'Cambridge Bay', 'Canada', 69.11, -105.05),
  ('America/Campo_Grande', 'Campo Grande', 'Brazil', -20.45, -54.62),
  ('America/Cancun', 'Cancún', 'Mexico', 21.08, -86.77),
  ('America/Caracas', 'Caracas', 'Venezuela', 10.5, -66.93),
  ('America/Cayenne', 'Cayenne', 'French Guiana', 4.93, -52.33),
  ('America/Cayman', 'George Town', 'Cayman Islands', 19.3, -81.38),
  ('America/Chicago', 'Chicago', 'United States', 41.85, -87.65),
  ('America/Chihuahua', 'Chihuahua', 'Mexico', 28.63, -106.08),
  ('America/Ciudad_Juarez', 'Ciudad Juárez', 'Mexico', 31.73, -106.48),
  ('America/Costa_Rica', 'San José', 'Costa Rica', 9.93, -84.08),
  ('America/Coyhaique', 'Coyhaique', 'Chile', -45.57, -72.07),
  ('America/Creston', 'Creston', 'Canada', 49.1, -116.52),
  ('America/Cuiaba', 'Cuiabá', 'Brazil', -15.58, -56.08),
  ('America/Curacao', 'Willemstad', 'Curaçao', 12.18, -69),
  ('America/Danmarkshavn', 'Danmarkshavn', 'Greenland', 76.77, -18.67),
  ('America/Dawson', 'Dawson', 'Canada', 64.07, -139.42),
  ('America/Dawson_Creek', 'Dawson Creek', 'Canada', 55.77, -120.23),
  ('America/Denver', 'Denver', 'United States', 39.74, -104.98),
  ('America/Detroit', 'Detroit', 'United States', 42.33, -83.05),
  ('America/Dominica', 'Roseau', 'Dominica', 15.3, -61.4),
  ('America/Edmonton', 'Edmonton', 'Canada', 53.55, -113.47),
  ('America/Eirunepe', 'Eirunepé', 'Brazil', -6.67, -69.87),
  ('America/El_Salvador', 'San Salvador', 'El Salvador', 13.7, -89.2),
  ('America/Fort_Nelson', 'Fort Nelson', 'Canada', 58.8, -122.7),
  ('America/Fortaleza', 'Fortaleza', 'Brazil', -3.72, -38.5),
  ('America/Glace_Bay', 'Glace Bay', 'Canada', 46.2, -59.95),
  ('America/Goose_Bay', 'Goose Bay', 'Canada', 53.33, -60.42),
  ('America/Grand_Turk', 'Grand Turk', 'Turks & Caicos Islands', 21.47, -71.13),
  ('America/Grenada', 'St. George''s', 'Grenada', 12.05, -61.75),
  ('America/Guadeloupe', 'Basse-Terre', 'Guadeloupe', 16.23, -61.53),
  ('America/Guatemala', 'Guatemala City', 'Guatemala', 14.63, -90.52),
  ('America/Guayaquil', 'Guayaquil', 'Ecuador', -2.17, -79.83),
  ('America/Guyana', 'Georgetown', 'Guyana', 6.8, -58.17),
  ('America/Halifax', 'Halifax', 'Canada', 44.65, -63.6),
  ('America/Havana', 'Havana', 'Cuba', 23.13, -82.37),
  ('America/Hermosillo', 'Hermosillo', 'Mexico', 29.07, -110.97),
  ('America/Indiana/Indianapolis', 'Indianapolis', 'United States', 39.77, -86.16),
  ('America/Indiana/Knox', 'Knox', 'United States', 41.3, -86.62),
  ('America/Indiana/Marengo', 'Marengo', 'United States', 38.38, -86.34),
  ('America/Indiana/Petersburg', 'Petersburg', 'United States', 38.49, -87.28),
  ('America/Indiana/Tell_City', 'Tell City', 'United States', 37.95, -86.76),
  ('America/Indiana/Vevay', 'Vevay', 'United States', 38.75, -85.07),
  ('America/Indiana/Vincennes', 'Vincennes', 'United States', 38.68, -87.53),
  ('America/Indiana/Winamac', 'Winamac', 'United States', 41.05, -86.6),
  ('America/Inuvik', 'Inuvik', 'Canada', 68.35, -133.72),
  ('America/Iqaluit', 'Iqaluit', 'Canada', 63.73, -68.47),
  ('America/Jamaica', 'Kingston', 'Jamaica', 17.97, -76.79),
  ('America/Juneau', 'Juneau', 'United States', 58.3, -134.42),
  ('America/Kentucky/Louisville', 'Louisville', 'United States', 38.25, -85.76),
  ('America/Kentucky/Monticello', 'Monticello', 'United States', 36.83, -84.85),
  ('America/Kralendijk', 'Kralendijk', 'Caribbean NL', 12.15, -68.28),
  ('America/La_Paz', 'La Paz', 'Bolivia', -16.5, -68.15),
  ('America/Lima', 'Lima', 'Peru', -12.05, -77.05),
  ('America/Los_Angeles', 'Los Angeles', 'United States', 34.05, -118.24),
  ('America/Lower_Princes', 'Philipsburg', 'Sint Maarten', 18.05, -63.05),
  ('America/Maceio', 'Maceió', 'Brazil', -9.67, -35.72),
  ('America/Managua', 'Managua', 'Nicaragua', 12.15, -86.28),
  ('America/Manaus', 'Manaus', 'Brazil', -3.13, -60.02),
  ('America/Marigot', 'Marigot', 'Saint Martin', 18.07, -63.08),
  ('America/Martinique', 'Fort-de-France', 'Martinique', 14.6, -61.08),
  ('America/Matamoros', 'Matamoros', 'Mexico', 25.83, -97.5),
  ('America/Mazatlan', 'Mazatlán', 'Mexico', 23.22, -106.42),
  ('America/Menominee', 'Menominee', 'United States', 45.11, -87.61),
  ('America/Merida', 'Mérida', 'Mexico', 20.97, -89.62),
  ('America/Metlakatla', 'Metlakatla', 'United States', 55.13, -131.58),
  ('America/Mexico_City', 'Mexico City', 'Mexico', 19.4, -99.15),
  ('America/Miquelon', 'Saint-Pierre', 'St Pierre & Miquelon', 47.05, -56.33),
  ('America/Moncton', 'Moncton', 'Canada', 46.1, -64.78),
  ('America/Monterrey', 'Monterrey', 'Mexico', 25.67, -100.32),
  ('America/Montevideo', 'Montevideo', 'Uruguay', -34.91, -56.21),
  ('America/Montserrat', 'Plymouth', 'Montserrat', 16.72, -62.22),
  ('America/Nassau', 'Nassau', 'Bahamas', 25.08, -77.35),
  ('America/New_York', 'New York', 'United States', 40.71, -74.01),
  ('America/Nome', 'Nome', 'United States', 64.5, -165.41),
  ('America/Noronha', 'Fernando de Noronha', 'Brazil', -3.85, -32.42),
  ('America/North_Dakota/Beulah', 'Beulah', 'United States', 47.26, -101.78),
  ('America/North_Dakota/Center', 'Center', 'United States', 47.12, -101.3),
  ('America/North_Dakota/New_Salem', 'New Salem', 'United States', 46.84, -101.41),
  ('America/Nuuk', 'Nuuk', 'Greenland', 64.18, -51.73),
  ('America/Ojinaga', 'Ojinaga', 'Mexico', 29.57, -104.42),
  ('America/Panama', 'Panama City', 'Panama', 8.97, -79.53),
  ('America/Paramaribo', 'Paramaribo', 'Suriname', 5.83, -55.17),
  ('America/Phoenix', 'Phoenix', 'United States', 33.45, -112.07),
  ('America/Port-au-Prince', 'Port-au-Prince', 'Haiti', 18.53, -72.33),
  ('America/Port_of_Spain', 'Port of Spain', 'Trinidad & Tobago', 10.65, -61.52),
  ('America/Porto_Velho', 'Porto Velho', 'Brazil', -8.77, -63.9),
  ('America/Puerto_Rico', 'San Juan', 'Puerto Rico', 18.47, -66.11),
  ('America/Punta_Arenas', 'Punta Arenas', 'Chile', -53.15, -70.92),
  ('America/Rankin_Inlet', 'Rankin Inlet', 'Canada', 62.82, -92.08),
  ('America/Recife', 'Recife', 'Brazil', -8.05, -34.9),
  ('America/Regina', 'Regina', 'Canada', 50.4, -104.65),
  ('America/Resolute', 'Resolute', 'Canada', 74.7, -94.83),
  ('America/Rio_Branco', 'Rio Branco', 'Brazil', -9.97, -67.8),
  ('America/Santarem', 'Santarém', 'Brazil', -2.43, -54.87),
  ('America/Santiago', 'Santiago', 'Chile', -33.45, -70.67),
  ('America/Santo_Domingo', 'Santo Domingo', 'Dominican Republic', 18.47, -69.9),
  ('America/Sao_Paulo', 'São Paulo', 'Brazil', -23.53, -46.62),
  ('America/Scoresbysund', 'Ittoqqortoormiit', 'Greenland', 70.48, -21.97),
  ('America/Sitka', 'Sitka', 'United States', 57.18, -135.3),
  ('America/St_Barthelemy', 'Gustavia', 'St Barthelemy', 17.88, -62.85),
  ('America/St_Johns', 'St. John''s', 'Canada', 47.57, -52.72),
  ('America/St_Kitts', 'Basseterre', 'St Kitts & Nevis', 17.3, -62.72),
  ('America/St_Lucia', 'Castries', 'St Lucia', 14.02, -61),
  ('America/St_Thomas', 'Charlotte Amalie', 'US Virgin Islands', 18.35, -64.93),
  ('America/St_Vincent', 'Kingstown', 'St Vincent', 13.15, -61.23),
  ('America/Swift_Current', 'Swift Current', 'Canada', 50.28, -107.83),
  ('America/Tegucigalpa', 'Tegucigalpa', 'Honduras', 14.1, -87.22),
  ('America/Thule', 'Pituffik', 'Greenland', 76.57, -68.78),
  ('America/Tijuana', 'Tijuana', 'Mexico', 32.53, -117.02),
  ('America/Toronto', 'Toronto', 'Canada', 43.65, -79.38),
  ('America/Tortola', 'Road Town', 'British Virgin Islands', 18.45, -64.62),
  ('America/Vancouver', 'Vancouver', 'Canada', 49.27, -123.12),
  ('America/Whitehorse', 'Whitehorse', 'Canada', 60.72, -135.05),
  ('America/Winnipeg', 'Winnipeg', 'Canada', 49.88, -97.15),
  ('America/Yakutat', 'Yakutat', 'United States', 59.55, -139.73),
  ('Antarctica/Casey', 'Casey Station', 'Antarctica', -66.28, 110.52),
  ('Antarctica/Davis', 'Davis Station', 'Antarctica', -68.58, 77.97),
  ('Antarctica/DumontDUrville', 'Dumont d''Urville Station', 'Antarctica', -66.67, 140.02),
  ('Antarctica/Macquarie', 'Macquarie Island', 'Australia', -54.5, 158.95),
  ('Antarctica/Mawson', 'Mawson Station', 'Antarctica', -67.6, 62.88),
  ('Antarctica/McMurdo', 'McMurdo Station', 'Antarctica', -77.83, 166.6),
  ('Antarctica/Palmer', 'Palmer Station', 'Antarctica', -64.8, -64.1),
  ('Antarctica/Rothera', 'Rothera Station', 'Antarctica', -67.57, -68.13),
  ('Antarctica/Syowa', 'Syowa Station', 'Antarctica', -69.01, 39.59),
  ('Antarctica/Troll', 'Troll Station', 'Antarctica', -72.01, 2.53),
  ('Antarctica/Vostok', 'Vostok Station', 'Antarctica', -78.4, 106.9),
  ('Arctic/Longyearbyen', 'Longyearbyen', 'Svalbard & Jan Mayen', 78, 16),
  ('Asia/Aden', 'Aden', 'Yemen', 12.75, 45.2),
  ('Asia/Almaty', 'Almaty', 'Kazakhstan', 43.25, 76.95),
  ('Asia/Amman', 'Amman', 'Jordan', 31.95, 35.93),
  ('Asia/Anadyr', 'Anadyr', 'Russia', 64.75, 177.48),
  ('Asia/Aqtau', 'Aqtau', 'Kazakhstan', 44.52, 50.27),
  ('Asia/Aqtobe', 'Aqtobe', 'Kazakhstan', 50.28, 57.17),
  ('Asia/Ashgabat', 'Ashgabat', 'Turkmenistan', 37.95, 58.38),
  ('Asia/Atyrau', 'Atyrau', 'Kazakhstan', 47.12, 51.93),
  ('Asia/Baghdad', 'Baghdad', 'Iraq', 33.35, 44.42),
  ('Asia/Bahrain', 'Manama', 'Bahrain', 26.38, 50.58),
  ('Asia/Baku', 'Baku', 'Azerbaijan', 40.38, 49.85),
  ('Asia/Bangkok', 'Bangkok', 'Thailand', 13.75, 100.52),
  ('Asia/Barnaul', 'Barnaul', 'Russia', 53.37, 83.75),
  ('Asia/Beirut', 'Beirut', 'Lebanon', 33.88, 35.5),
  ('Asia/Bishkek', 'Bishkek', 'Kyrgyzstan', 42.9, 74.6),
  ('Asia/Brunei', 'Bandar Seri Begawan', 'Brunei', 4.93, 114.92),
  ('Asia/Chita', 'Chita', 'Russia', 52.05, 113.47),
  ('Asia/Colombo', 'Colombo', 'Sri Lanka', 6.93, 79.85),
  ('Asia/Damascus', 'Damascus', 'Syria', 33.5, 36.3),
  ('Asia/Dhaka', 'Dhaka', 'Bangladesh', 23.72, 90.42),
  ('Asia/Dili', 'Dili', 'East Timor', -8.55, 125.58),
  ('Asia/Dubai', 'Dubai', 'United Arab Emirates', 25.3, 55.3),
  ('Asia/Dushanbe', 'Dushanbe', 'Tajikistan', 38.58, 68.8),
  ('Asia/Famagusta', 'Famagusta', 'Cyprus', 35.12, 33.95),
  ('Asia/Gaza', 'Gaza', 'Palestine', 31.5, 34.47),
  ('Asia/Hebron', 'Hebron', 'Palestine', 31.53, 35.09),
  ('Asia/Ho_Chi_Minh', 'Ho Chi Minh City', 'Vietnam', 10.75, 106.67),
  ('Asia/Hong_Kong', 'Hong Kong', 'Hong Kong', 22.28, 114.15),
  ('Asia/Hovd', 'Hovd', 'Mongolia', 48.02, 91.65),
  ('Asia/Irkutsk', 'Irkutsk', 'Russia', 52.27, 104.33),
  ('Asia/Jakarta', 'Jakarta', 'Indonesia', -6.17, 106.8),
  ('Asia/Jayapura', 'Jayapura', 'Indonesia', -2.53, 140.7),
  ('Asia/Jerusalem', 'Jerusalem', 'Israel', 31.78, 35.22),
  ('Asia/Kabul', 'Kabul', 'Afghanistan', 34.52, 69.2),
  ('Asia/Kamchatka', 'Kamchatka', 'Russia', 53.02, 158.65),
  ('Asia/Karachi', 'Karachi', 'Pakistan', 24.87, 67.05),
  ('Asia/Kathmandu', 'Kathmandu', 'Nepal', 27.72, 85.32),
  ('Asia/Khandyga', 'Khandyga', 'Russia', 62.66, 135.55),
  ('Asia/Kolkata', 'Kolkata', 'India', 22.53, 88.37),
  ('Asia/Krasnoyarsk', 'Krasnoyarsk', 'Russia', 56.02, 92.83),
  ('Asia/Kuala_Lumpur', 'Kuala Lumpur', 'Malaysia', 3.17, 101.7),
  ('Asia/Kuching', 'Kuching', 'Malaysia', 1.55, 110.33),
  ('Asia/Kuwait', 'Kuwait City', 'Kuwait', 29.33, 47.98),
  ('Asia/Macau', 'Macau', 'Macau', 22.2, 113.54),
  ('Asia/Magadan', 'Magadan', 'Russia', 59.57, 150.8),
  ('Asia/Makassar', 'Makassar', 'Indonesia', -5.12, 119.4),
  ('Asia/Manila', 'Manila', 'Philippines', 14.59, 120.97),
  ('Asia/Muscat', 'Muscat', 'Oman', 23.6, 58.58),
  ('Asia/Nicosia', 'Nicosia', 'Cyprus', 35.17, 33.37),
  ('Asia/Novokuznetsk', 'Novokuznetsk', 'Russia', 53.75, 87.12),
  ('Asia/Novosibirsk', 'Novosibirsk', 'Russia', 55.03, 82.92),
  ('Asia/Omsk', 'Omsk', 'Russia', 55, 73.4),
  ('Asia/Oral', 'Oral', 'Kazakhstan', 51.22, 51.35),
  ('Asia/Phnom_Penh', 'Phnom Penh', 'Cambodia', 11.55, 104.92),
  ('Asia/Pontianak', 'Pontianak', 'Indonesia', -0.03, 109.33),
  ('Asia/Pyongyang', 'Pyongyang', 'North Korea', 39.02, 125.75),
  ('Asia/Qatar', 'Doha', 'Qatar', 25.28, 51.53),
  ('Asia/Qostanay', 'Qostanay', 'Kazakhstan', 53.2, 63.62),
  ('Asia/Qyzylorda', 'Qyzylorda', 'Kazakhstan', 44.8, 65.47),
  ('Asia/Riyadh', 'Riyadh', 'Saudi Arabia', 24.63, 46.72),
  ('Asia/Sakhalin', 'Sakhalin', 'Russia', 46.97, 142.7),
  ('Asia/Samarkand', 'Samarkand', 'Uzbekistan', 39.67, 66.8),
  ('Asia/Seoul', 'Seoul', 'South Korea', 37.55, 126.97),
  ('Asia/Shanghai', 'Shanghai', 'China', 31.23, 121.47),
  ('Asia/Singapore', 'Singapore', 'Singapore', 1.28, 103.85),
  ('Asia/Srednekolymsk', 'Srednekolymsk', 'Russia', 67.47, 153.72),
  ('Asia/Taipei', 'Taipei', 'Taiwan', 25.05, 121.5),
  ('Asia/Tashkent', 'Tashkent', 'Uzbekistan', 41.33, 69.3),
  ('Asia/Tbilisi', 'Tbilisi', 'Georgia', 41.72, 44.82),
  ('Asia/Tehran', 'Tehran', 'Iran', 35.67, 51.43),
  ('Asia/Thimphu', 'Thimphu', 'Bhutan', 27.47, 89.65),
  ('Asia/Tokyo', 'Tokyo', 'Japan', 35.65, 139.74),
  ('Asia/Tomsk', 'Tomsk', 'Russia', 56.5, 84.97),
  ('Asia/Ulaanbaatar', 'Ulaanbaatar', 'Mongolia', 47.92, 106.88),
  ('Asia/Urumqi', 'Ürümqi', 'China', 43.8, 87.58),
  ('Asia/Ust-Nera', 'Ust-Nera', 'Russia', 64.56, 143.23),
  ('Asia/Vientiane', 'Vientiane', 'Laos', 17.97, 102.6),
  ('Asia/Vladivostok', 'Vladivostok', 'Russia', 43.17, 131.93),
  ('Asia/Yakutsk', 'Yakutsk', 'Russia', 62, 129.67),
  ('Asia/Yangon', 'Yangon', 'Myanmar', 16.78, 96.17),
  ('Asia/Yekaterinburg', 'Yekaterinburg', 'Russia', 56.85, 60.6),
  ('Asia/Yerevan', 'Yerevan', 'Armenia', 40.18, 44.5),
  ('Atlantic/Azores', 'Ponta Delgada', 'Portugal', 37.73, -25.67),
  ('Atlantic/Bermuda', 'Hamilton', 'Bermuda', 32.28, -64.77),
  ('Atlantic/Canary', 'Las Palmas', 'Spain', 28.1, -15.4),
  ('Atlantic/Cape_Verde', 'Praia', 'Cape Verde', 14.92, -23.52),
  ('Atlantic/Faroe', 'Tórshavn', 'Faroe Islands', 62.02, -6.77),
  ('Atlantic/Madeira', 'Funchal', 'Portugal', 32.63, -16.9),
  ('Atlantic/Reykjavik', 'Reykjavík', 'Iceland', 64.15, -21.85),
  ('Atlantic/South_Georgia', 'South Georgia', 'South Georgia', -54.27, -36.53),
  ('Atlantic/St_Helena', 'Jamestown', 'St Helena', -15.92, -5.7),
  ('Atlantic/Stanley', 'Stanley', 'Falkland Islands', -51.7, -57.85),
  ('Australia/Adelaide', 'Adelaide', 'Australia', -34.92, 138.58),
  ('Australia/Brisbane', 'Brisbane', 'Australia', -27.47, 153.03),
  ('Australia/Broken_Hill', 'Broken Hill', 'Australia', -31.95, 141.45),
  ('Australia/Darwin', 'Darwin', 'Australia', -12.47, 130.83),
  ('Australia/Eucla', 'Eucla', 'Australia', -31.72, 128.87),
  ('Australia/Hobart', 'Hobart', 'Australia', -42.88, 147.32),
  ('Australia/Lindeman', 'Lindeman Island', 'Australia', -20.27, 149),
  ('Australia/Lord_Howe', 'Lord Howe Island', 'Australia', -31.55, 159.08),
  ('Australia/Melbourne', 'Melbourne', 'Australia', -37.82, 144.97),
  ('Australia/Perth', 'Perth', 'Australia', -31.95, 115.85),
  ('Australia/Sydney', 'Sydney', 'Australia', -33.87, 151.22),
  ('Europe/Amsterdam', 'Amsterdam', 'Netherlands', 52.37, 4.9),
  ('Europe/Andorra', 'Andorra la Vella', 'Andorra', 42.5, 1.52),
  ('Europe/Astrakhan', 'Astrakhan', 'Russia', 46.35, 48.05),
  ('Europe/Athens', 'Athens', 'Greece', 37.97, 23.72),
  ('Europe/Belgrade', 'Belgrade', 'Serbia', 44.83, 20.5),
  ('Europe/Berlin', 'Berlin', 'Germany', 52.5, 13.37),
  ('Europe/Bratislava', 'Bratislava', 'Slovakia', 48.15, 17.12),
  ('Europe/Brussels', 'Brussels', 'Belgium', 50.83, 4.33),
  ('Europe/Bucharest', 'Bucharest', 'Romania', 44.43, 26.1),
  ('Europe/Budapest', 'Budapest', 'Hungary', 47.5, 19.08),
  ('Europe/Busingen', 'Büsingen', 'Germany', 47.7, 8.68),
  ('Europe/Chisinau', 'Chișinău', 'Moldova', 47, 28.83),
  ('Europe/Copenhagen', 'Copenhagen', 'Denmark', 55.67, 12.58),
  ('Europe/Dublin', 'Dublin', 'Ireland', 53.33, -6.25),
  ('Europe/Gibraltar', 'Gibraltar', 'Gibraltar', 36.13, -5.35),
  ('Europe/Guernsey', 'St Peter Port', 'Guernsey', 49.45, -2.54),
  ('Europe/Helsinki', 'Helsinki', 'Finland', 60.17, 24.97),
  ('Europe/Isle_of_Man', 'Douglas', 'Isle of Man', 54.15, -4.47),
  ('Europe/Istanbul', 'Istanbul', 'Turkey', 41.02, 28.97),
  ('Europe/Jersey', 'St Helier', 'Jersey', 49.18, -2.11),
  ('Europe/Kaliningrad', 'Kaliningrad', 'Russia', 54.72, 20.5),
  ('Europe/Kirov', 'Kirov', 'Russia', 58.6, 49.65),
  ('Europe/Kyiv', 'Kyiv', 'Ukraine', 50.43, 30.52),
  ('Europe/Lisbon', 'Lisbon', 'Portugal', 38.72, -9.13),
  ('Europe/Ljubljana', 'Ljubljana', 'Slovenia', 46.05, 14.52),
  ('Europe/London', 'London', 'United Kingdom', 51.51, -0.13),
  ('Europe/Luxembourg', 'Luxembourg', 'Luxembourg', 49.6, 6.15),
  ('Europe/Madrid', 'Madrid', 'Spain', 40.4, -3.68),
  ('Europe/Malta', 'Valletta', 'Malta', 35.9, 14.52),
  ('Europe/Mariehamn', 'Mariehamn', 'Åland Islands', 60.1, 19.95),
  ('Europe/Minsk', 'Minsk', 'Belarus', 53.9, 27.57),
  ('Europe/Monaco', 'Monaco', 'Monaco', 43.7, 7.38),
  ('Europe/Moscow', 'Moscow', 'Russia', 55.76, 37.62),
  ('Europe/Oslo', 'Oslo', 'Norway', 59.92, 10.75),
  ('Europe/Paris', 'Paris', 'France', 48.87, 2.33),
  ('Europe/Podgorica', 'Podgorica', 'Montenegro', 42.43, 19.27),
  ('Europe/Prague', 'Prague', 'Czechia', 50.08, 14.43),
  ('Europe/Riga', 'Riga', 'Latvia', 56.95, 24.1),
  ('Europe/Rome', 'Rome', 'Italy', 41.9, 12.48),
  ('Europe/Samara', 'Samara', 'Russia', 53.2, 50.15),
  ('Europe/San_Marino', 'San Marino', 'San Marino', 43.92, 12.47),
  ('Europe/Sarajevo', 'Sarajevo', 'Bosnia & Herzegovina', 43.87, 18.42),
  ('Europe/Saratov', 'Saratov', 'Russia', 51.57, 46.03),
  ('Europe/Simferopol', 'Simferopol', 'Russia', 44.95, 34.1),
  ('Europe/Skopje', 'Skopje', 'North Macedonia', 41.98, 21.43),
  ('Europe/Sofia', 'Sofia', 'Bulgaria', 42.68, 23.32),
  ('Europe/Stockholm', 'Stockholm', 'Sweden', 59.33, 18.05),
  ('Europe/Tallinn', 'Tallinn', 'Estonia', 59.42, 24.75),
  ('Europe/Tirane', 'Tirane', 'Albania', 41.33, 19.83),
  ('Europe/Ulyanovsk', 'Ulyanovsk', 'Russia', 54.33, 48.4),
  ('Europe/Vaduz', 'Vaduz', 'Liechtenstein', 47.15, 9.52),
  ('Europe/Vatican', 'Vatican City', 'Vatican City', 41.9, 12.45),
  ('Europe/Vienna', 'Vienna', 'Austria', 48.22, 16.33),
  ('Europe/Vilnius', 'Vilnius', 'Lithuania', 54.68, 25.32),
  ('Europe/Volgograd', 'Volgograd', 'Russia', 48.73, 44.42),
  ('Europe/Warsaw', 'Warsaw', 'Poland', 52.25, 21),
  ('Europe/Zagreb', 'Zagreb', 'Croatia', 45.8, 15.97),
  ('Europe/Zurich', 'Zürich', 'Switzerland', 47.38, 8.53),
  ('Indian/Antananarivo', 'Antananarivo', 'Madagascar', -18.92, 47.52),
  ('Indian/Chagos', 'Chagos Archipelago', 'British Indian Ocean Territory', -7.33, 72.42),
  ('Indian/Christmas', 'Christmas Island', 'Christmas Island', -10.42, 105.72),
  ('Indian/Cocos', 'Cocos Islands', 'Cocos (Keeling) Islands', -12.17, 96.92),
  ('Indian/Comoro', 'Moroni', 'Comoros', -11.68, 43.27),
  ('Indian/Kerguelen', 'Port-aux-Français', 'French S. Terr.', -49.35, 70.22),
  ('Indian/Mahe', 'Victoria', 'Seychelles', -4.67, 55.47),
  ('Indian/Maldives', 'Malé', 'Maldives', 4.17, 73.5),
  ('Indian/Mauritius', 'Port Louis', 'Mauritius', -20.17, 57.5),
  ('Indian/Mayotte', 'Mamoudzou', 'Mayotte', -12.78, 45.23),
  ('Indian/Reunion', 'Saint-Denis', 'Réunion', -20.87, 55.47),
  ('Pacific/Apia', 'Apia', 'Samoa', -13.83, -171.73),
  ('Pacific/Auckland', 'Auckland', 'New Zealand', -36.87, 174.77),
  ('Pacific/Bougainville', 'Bougainville', 'Papua New Guinea', -6.22, 155.57),
  ('Pacific/Chatham', 'Chatham Islands', 'New Zealand', -43.95, -176.55),
  ('Pacific/Chuuk', 'Chuuk', 'Micronesia', 7.42, 151.78),
  ('Pacific/Easter', 'Easter Island', 'Chile', -27.15, -109.43),
  ('Pacific/Efate', 'Port Vila', 'Vanuatu', -17.67, 168.42),
  ('Pacific/Fakaofo', 'Fakaofo', 'Tokelau', -9.37, -171.23),
  ('Pacific/Fiji', 'Suva', 'Fiji', -18.13, 178.42),
  ('Pacific/Funafuti', 'Funafuti', 'Tuvalu', -8.52, 179.22),
  ('Pacific/Galapagos', 'Galápagos', 'Ecuador', -0.9, -89.6),
  ('Pacific/Gambier', 'Gambier Islands', 'French Polynesia', -23.13, -134.95),
  ('Pacific/Guadalcanal', 'Honiara', 'Solomon Islands', -9.53, 160.2),
  ('Pacific/Guam', 'Hagåtña', 'Guam', 13.47, 144.75),
  ('Pacific/Honolulu', 'Honolulu', 'United States', 21.31, -157.86),
  ('Pacific/Kanton', 'Kanton Island', 'Kiribati', -2.78, -171.72),
  ('Pacific/Kiritimati', 'Kiritimati', 'Kiribati', 1.87, -157.33),
  ('Pacific/Kosrae', 'Kosrae', 'Micronesia', 5.32, 162.98),
  ('Pacific/Kwajalein', 'Kwajalein', 'Marshall Islands', 9.08, 167.33),
  ('Pacific/Majuro', 'Majuro', 'Marshall Islands', 7.15, 171.2),
  ('Pacific/Marquesas', 'Marquesas Islands', 'French Polynesia', -9, -139.5),
  ('Pacific/Midway', 'Midway Atoll', 'US minor outlying islands', 28.22, -177.37),
  ('Pacific/Nauru', 'Yaren', 'Nauru', -0.52, 166.92),
  ('Pacific/Niue', 'Alofi', 'Niue', -19.02, -169.92),
  ('Pacific/Norfolk', 'Norfolk Island', 'Norfolk Island', -29.05, 167.97),
  ('Pacific/Noumea', 'Nouméa', 'New Caledonia', -22.27, 166.45),
  ('Pacific/Pago_Pago', 'Pago Pago', 'American Samoa', -14.27, -170.7),
  ('Pacific/Palau', 'Ngerulmud', 'Palau', 7.33, 134.48),
  ('Pacific/Pitcairn', 'Adamstown', 'Pitcairn', -25.07, -130.08),
  ('Pacific/Pohnpei', 'Pohnpei', 'Micronesia', 6.97, 158.22),
  ('Pacific/Port_Moresby', 'Port Moresby', 'Papua New Guinea', -9.5, 147.17),
  ('Pacific/Rarotonga', 'Avarua', 'Cook Islands', -21.23, -159.77),
  ('Pacific/Saipan', 'Saipan', 'Northern Mariana Islands', 15.2, 145.75),
  ('Pacific/Tahiti', 'Papeete', 'French Polynesia', -17.53, -149.57),
  ('Pacific/Tarawa', 'Tarawa', 'Kiribati', 1.42, 173),
  ('Pacific/Tongatapu', 'Nukuʻalofa', 'Tonga', -21.13, -175.2),
  ('Pacific/Wake', 'Wake Island', 'US minor outlying islands', 19.28, 166.62),
  ('Pacific/Wallis', 'Mata-Utu', 'Wallis & Futuna', -13.3, -176.17);

-- ───────────────────────────── limits ─────────────────────────────
-- Tunable ceilings, so a breaker can be tightened (or tested) without a migration. No client access.

create table public.limits (
  key   text primary key,
  value int  not null,
  def   int  not null
);
alter table public.limits enable row level security;
revoke all on public.limits from public, anon, authenticated;

insert into public.limits (key, value, def) values
  ('wave_per_min',         8,   8),    -- send_wave calls per uid per minute
  ('threads_per_uid_day',  20,  20),   -- threads a uid may be part of per rolling 24 h
  ('threads_global_hour',  300, 300),  -- more threads than this in the last hour: no new threads
  ('lanterns_global_hour', 600, 600),  -- more lanterns than this in the last hour: release refused
  ('reports_per_day',      5,   5),    -- reports per uid per rolling 24 h
  ('autohide_per_hour',    20,  20),   -- more auto-hides than this in the last hour: stop hiding
  ('zones_per_uid_day',    3,   3);    -- distinct zones a uid may light per UTC day

create function public._limit(p_key text) returns int
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v int;
begin
  select value into strict v from limits where key = p_key;
  return v;
end $$;

-- ───────────────────────────── columns ─────────────────────────────

alter table public.lanterns add column hidden_at timestamptz;
create index lanterns_hidden_at_idx on public.lanterns (hidden_at) where hidden_at is not null;

-- Who lit a zone today. Not granted to clients (column-level grants), so it is not in realtime
-- payloads either.
alter table public.zone_days add column uid uuid;
create index zone_days_uid_idx on public.zone_days (uid, day);

-- ───────────────────────────── text screen ─────────────────────────────

-- NFKC, then invisible characters out, then control characters and whitespace runs to one space.
-- ZWNJ / ZWJ (U+200C, U+200D) survive only between two characters outside the Latin, Greek and
-- Cyrillic blocks (Persian, Indic scripts and emoji sequences need them); everywhere else they go,
-- and the blocklist copy in _text_problem drops them unconditionally.
create or replace function public._squash(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select btrim(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(normalize(coalesce(p, ''), NFKC),
      '[​‎‏‪-‮⁠-⁩﻿­͏؜ᅟᅠ឴឵᠋-᠎ㅤﾠ]', '', 'g'),
      '(^|[\u0001-׿])[‌‍]+', '\1', 'g'),
      '[‌‍]+($|(?=[\u0001-׿]))', '', 'g'),
      '([‌‍])[‌‍]+', '\1', 'g'),
      '[\u0001-\u001F\u007F-\u009F  ]', ' ', 'g'),
      '\s+', ' ', 'g'));
$$;

-- Returns null when clean, otherwise the machine-readable reason. Expects _squash()ed text.
-- The blocklist runs on a copy that is NFKD-normalised, stripped of combining marks and invisible
-- characters, and lower-cased, so accents, full-width letters and zero-width splits do not hide a word.
create or replace function public._text_problem(p text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  m text := lower(regexp_replace(normalize(coalesce(p, ''), NFKD),
    '[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯​-‏‪-‮⁠-⁩﻿­͏؜ᅟᅠ឴឵᠋-᠎ㅤﾠ]',
    '', 'g'));
  t text;
begin
  foreach t in array array[p, m] loop
    if t ~* '(https?:|ftp:|www\.|://)'
       or t ~* '\m[a-z0-9-]+\.(com|net|org|io|co|ly|gg|tv|cc|app|dev|xyz|info|biz|link|ru|uk|de|fr|nl|br|cn|jp|au)\M'
       or t ~* '[a-z0-9]\.[a-z]{2,}/'
       or t ~* '\m[a-z0-9-]+\s*(\(dot\)|\[dot\]|\sdot\s)\s*(com|net|org|io)\M' then
      return 'link';
    end if;
  end loop;
  foreach t in array array[p, m] loop
    if t ~ '@\s*[[:alnum:]_]'
       or t ~* '\m(at)\s+[a-z0-9-]+\s+dot\s+[a-z]{2,}\M'
       or t ~ '(\d[\s().+-]*){8,}' then
      return 'contact';
    end if;
  end loop;

  -- Stacked combining marks ("zalgo"). After NFKC an ordinary accented letter carries no loose
  -- mark at all, so three loose general-purpose diacritics in a row are never ordinary writing.
  -- Script-specific marks (Hebrew points, Arabic harakat, Thai and Lao vowels and tones) stack
  -- two or three deep in real text, so they only count at five in a row. Devanagari and the other
  -- Indic scripts are not counted at all.
  if p ~ '[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯]{3,}'
     or p ~ '[̀-ͯ҃-҉֑-ׇֽֿׁׂׅׄؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭัิ-ฺ็-๎ັິ-ຼ່-ໍ᪰-᫿᷀-᷿⃐-⃿︠-︯]{5,}' then
    return 'blocked';
  end if;

  -- Strongest stems match anywhere in a word (clusterfuck, dumbfuck); "snigger" and "niggardly"
  -- are let through on purpose.
  if m ~ '(fu+c+k|motherf|cocksuck|assh[o0]le|b[i1]tch|d[i1]ckhead|f[a4]gg[o0]t|(bull|horse|dip|bat|ape|dog|chicken)sh[i1]t|(?<!\ms)n[i1]gg(er|uh|a(?!rd)))' then
    return 'blocked';
  end if;
  -- The rest only as whole words, so Scunthorpe, cocktail, Hancock, shiitake, Essex and grape pass.
  if m ~ '\m(f+u+c+k+\w*|sh[i1]+t+(s|y|ty|ted|ting|ter|ters|head\w*|hole\w*|show\w*|bag\w*|face\w*|load\w*|storm\w*|post\w*)?|c+u+n+t+s?|a+s+s+h+o+l+e+s?|c[o0]cks?|pussy|pussies|wh[o0]res?|sluts?|bastards?|wank\w*|twats?|jizz|cum|rape[ds]?|rapist\w*|raping|porn\w*|f[a4]gg?(ot)?s?|k[i1]kes?|sp[i1]cs?|ch[i1]nks?|g[o0]{2}ks?|wetbacks?|tr[a4]nn(y|ie)s?|retard\w*|dykes?|coons?|paki(s)?|kys|kill\s+yourself|nazis?|hitler)\M' then
    return 'blocked';
  end if;
  return null;
end $$;

-- Place names now come from the places table, never from the client.
drop function public._clean_place(text);

-- ───────────────────────────── place and zone helpers ─────────────────────────────

-- The place for a time zone, after checking the caller's position is inside the jitter box around
-- its centre (the client jitters by up to 0.6 degrees per axis). Anything else is invalid_input.
create function public._place(p_tz text, p_lat real, p_lon real) returns public.places
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v places;
begin
  perform _check_geo(p_lat, p_lon);
  if p_tz is null then raise exception 'invalid_input'; end if;
  select * into v from places where tz = p_tz;
  if not found then raise exception 'invalid_input'; end if;
  if not (abs(p_lat::float8 - v.lat) <= 0.61) then raise exception 'invalid_input'; end if;
  -- |shortest signed difference in longitude|, so 179.9 and -179.9 are 0.2 apart
  if not (abs((p_lon::float8 - v.lon + 540) - 360 * floor((p_lon::float8 - v.lon + 540) / 360) - 180) <= 0.61) then
    raise exception 'invalid_input';
  end if;
  return v;
end $$;

-- Which of the 24 whole-hour bands a zone is in right now. Must agree with zoneIndex() in
-- src/lib/time.ts: JS Math.round rounds halves toward +infinity, hence floor(x + 0.5), not round().
-- If this Postgres does not know the zone name, the client's value is used.
create function public._zone_for_tz(p_tz text, p_fallback int) returns int
language plpgsql stable set search_path = public, pg_temp as $$
declare h int;
begin
  begin
    h := floor(extract(epoch from ((now() at time zone p_tz) - (now() at time zone 'UTC'))) / 3600.0 + 0.5)::int;
  exception when others then
    h := null;
  end;
  if h is null then
    if p_fallback is null or p_fallback < 0 or p_fallback > 23 then raise exception 'invalid_input'; end if;
    return p_fallback;
  end if;
  return ((h % 24) + 24) % 24;
end $$;

-- ───────────────────────────── client-facing functions ─────────────────────────────

-- p_place is ignored (kept so deployed clients keep working); the stored name is places.city.
-- p_zone is only a fallback for a zone name this Postgres does not know.
create or replace function public.check_in(p_lat real, p_lon real, p_place text, p_tz text, p_zone int)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_pl places;
  v_zone int;
begin
  v_pl := _place(p_tz, p_lat, p_lon);
  if p_zone is not null and (p_zone < 0 or p_zone > 23) then raise exception 'invalid_input'; end if;
  v_zone := _zone_for_tz(p_tz, p_zone);

  if not _rate_take(v_uid, 'check_in', interval '1 hour', 30) then return; end if;

  insert into echoes (uid, lat, lon, place, tz, zone, last_seen)
  values (v_uid, p_lat, p_lon, v_pl.city, v_pl.tz, v_zone, now())
  on conflict (uid) do update
    set lat = excluded.lat, lon = excluded.lon, place = excluded.place,
        tz = excluded.tz, zone = excluded.zone, last_seen = now();

  -- _rate_take holds the per-uid lock, so this count cannot be raced by the same uid.
  if (select count(*) from zone_days where day = _utc_day() and uid = v_uid) < _limit('zones_per_uid_day') then
    insert into zone_days (day, zone, place, uid) values (_utc_day(), v_zone, v_pl.city, v_uid)
    on conflict do nothing;
  end if;
end $$;

-- The lantern is stored at the place centre plus a fresh random offset of up to 0.5 degrees per
-- axis, not at the caller's own (stable) coordinates, so it cannot be tied to a live light.
create or replace function public.release_lantern(p_body text, p_question_id int, p_lat real, p_lon real,
                                                  p_place text, p_tz text)
returns json
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_body text := _squash(p_body);
  v_pl places;
  v_problem text;
  v_lat float8;
  v_lon float8;
  v_row lanterns;
begin
  if v_body = '' then raise exception 'empty'; end if;
  if char_length(v_body) > 140 then raise exception 'too_long'; end if;
  v_problem := _text_problem(v_body);
  if v_problem is not null then raise exception '%', v_problem; end if;

  v_pl := _place(p_tz, p_lat, p_lon);
  if p_question_id is null or p_question_id < 0 or p_question_id > 100000 then
    raise exception 'invalid_input';
  end if;

  if (select count(*) from lanterns where created_at > now() - interval '1 hour') > _limit('lanterns_global_hour') then
    raise exception 'rate_limited';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  if exists (select 1 from rate_events
              where uid = v_uid and kind = 'lantern' and at > now() - interval '30 seconds')
     or (select count(*) from rate_events
          where uid = v_uid and kind = 'lantern'
            and at >= (_utc_day()::timestamp at time zone 'utc')) >= 5 then
    raise exception 'rate_limited';
  end if;
  insert into rate_events (uid, kind) values (v_uid, 'lantern');

  v_lat := greatest(-89.5, least(89.5, v_pl.lat + (random() * 2 - 1) * 0.5));
  v_lon := v_pl.lon + (random() * 2 - 1) * 0.5;
  v_lon := v_lon - 360 * floor((v_lon + 180) / 360);

  insert into lanterns (uid, day, question_id, body, lat, lon, place, tz)
  values (v_uid, _utc_day(), p_question_id, v_body,
          round(v_lat::numeric, 3)::real, round(v_lon::numeric, 3)::real, v_pl.city, v_pl.tz)
  returning * into v_row;

  return _lantern_json(v_row);
end $$;

-- Existence and "already warmed" are checked before any rate budget is spent.
create or replace function public.warm_lantern(p_id uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_warmth int;
begin
  select warmth into v_warmth from lanterns
   where id = p_id and not hidden and (seeded or created_at > now() - interval '48 hours');
  if not found then raise exception 'not_found'; end if;

  if exists (select 1 from warmths where lantern_id = p_id and uid = v_uid) then
    return v_warmth;
  end if;

  if not _rate_take(v_uid, 'warm', interval '1 hour', 60) then
    raise exception 'rate_limited';
  end if;

  insert into warmths (lantern_id, uid) values (p_id, v_uid) on conflict do nothing;
  if found then
    update lanterns set warmth = warmth + 1 where id = p_id returning warmth into v_warmth;
  end if;
  return v_warmth;
end $$;

create or replace function public.report_lantern(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_reports int;
  v_hide boolean;
begin
  -- Nothing to report (unknown, seeded, already hidden, expired, or already reported by this
  -- uid): return without spending budget. Welcome notes from the project cannot be reported away.
  if not exists (select 1 from lanterns
                  where id = p_id and not seeded and not hidden
                    and created_at > now() - interval '48 hours') then
    return;
  end if;
  if exists (select 1 from reports where lantern_id = p_id and uid = v_uid) then return; end if;

  if not _rate_take(v_uid, 'report', interval '24 hours', _limit('reports_per_day')) then
    raise exception 'rate_limited';
  end if;

  select reports into v_reports from lanterns
   where id = p_id and not seeded and not hidden for update;
  if not found then return; end if;

  insert into reports (lantern_id, uid) values (p_id, v_uid) on conflict do nothing;
  if not found then return; end if;

  -- Breaker: a report brigade cannot empty the sky. Past the hourly ceiling reports are still
  -- counted but nothing more is hidden automatically.
  v_hide := v_reports + 1 >= 3
    and (select count(*) from lanterns where hidden_at > now() - interval '1 hour') <= _limit('autohide_per_hour');

  update lanterns
     set reports = reports + 1,
         hidden = v_hide,
         hidden_at = case when v_hide then now() end
   where id = p_id;

  -- A hidden row no longer passes the select policy, so postgres_changes cannot announce it.
  -- Tell open clients over the public `sky` channel instead. Best effort only.
  if v_hide then
    begin
      perform realtime.send(jsonb_build_object('id', p_id), 'lantern_hidden', 'sky', false);
    exception when others then null;
    end;
  end if;
end $$;

-- New signature: p_tz added with a default, so a call with the four old named arguments still
-- resolves here. The old four-argument function is dropped so PostgREST sees no overload.
drop function public.send_wave(uuid, real, real, text);

create function public.send_wave(p_to uuid, p_lat real, p_lon real, p_place text, p_tz text default null)
returns json
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_tz text;
  v_pl places;
  v_theirs waves;
  v_thread threads;
  v_cap int;
begin
  if p_to is null or p_to = v_uid then raise exception 'invalid_target'; end if;
  perform _check_geo(p_lat, p_lon);
  -- Older clients send no zone: use the one from their last check_in.
  v_tz := coalesce(p_tz, (select e.tz from echoes e where e.uid = v_uid));
  v_pl := _place(v_tz, p_lat, p_lon);

  if not _rate_take(v_uid, 'wave', interval '1 minute', _limit('wave_per_min')) then
    raise exception 'rate_limited';
  end if;

  -- One lock per unordered pair, so two waves crossing in flight make one thread, not two.
  perform pg_advisory_xact_lock(
    hashtextextended(least(v_uid, p_to)::text || greatest(v_uid, p_to)::text, 1));

  insert into waves (from_uid, to_uid, lat, lon, place) values (v_uid, p_to, p_lat, p_lon, v_pl.city);

  select * into v_theirs from waves
   where to_uid = v_uid and from_uid = p_to and created_at > now() - interval '10 minutes'
   order by created_at desc limit 1;
  if not found then return json_build_object('thread', null); end if;

  if exists (select 1 from threads
              where created_at > now() - interval '24 hours'
                and ((a_uid = v_uid and b_uid = p_to) or (a_uid = p_to and b_uid = v_uid))) then
    return json_build_object('thread', null);
  end if;

  -- Growth limits: per participant per day, and a global hourly breaker.
  v_cap := _limit('threads_per_uid_day');
  if (select count(*) from threads
       where created_at > now() - interval '24 hours' and (a_uid = v_uid or b_uid = v_uid)) >= v_cap
     or (select count(*) from threads
          where created_at > now() - interval '24 hours' and (a_uid = p_to or b_uid = p_to)) >= v_cap
     or (select count(*) from threads where created_at > now() - interval '1 hour')
          > _limit('threads_global_hour') then
    return json_build_object('thread', null);
  end if;

  insert into threads (a_uid, b_uid, a_lat, a_lon, a_place, b_lat, b_lon, b_place, km)
  values (p_to, v_uid, v_theirs.lat, v_theirs.lon, v_theirs.place, p_lat, p_lon, v_pl.city,
          _km(v_theirs.lat, v_theirs.lon, p_lat, p_lon))
  returning * into v_thread;

  update world_totals set threads_total = threads_total + 1, km_total = km_total + v_thread.km
   where id;

  return json_build_object('thread', json_build_object(
    'id', v_thread.id,
    'a_lat', v_thread.a_lat, 'a_lon', v_thread.a_lon, 'a_place', v_thread.a_place,
    'b_lat', v_thread.b_lat, 'b_lon', v_thread.b_lon, 'b_place', v_thread.b_place,
    'km', v_thread.km, 'created_at', v_thread.created_at));
end $$;

-- ───────────────────────────── housekeeping ─────────────────────────────

-- Every limiter's window is inside its retention: wave 1 min (kept 5 min); warm and check_in 1 h
-- (kept 2 h); lantern = UTC day and report = 24 h (kept 2 days). The mutual-wave window is 10 min
-- (waves kept 15). world_totals keeps the running thread totals after old threads go.
create or replace function public._prune() returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from lanterns where not seeded and created_at < now() - interval '7 days';
  delete from waves where created_at < now() - interval '15 minutes';
  delete from threads where created_at < now() - interval '14 days';
  delete from rate_events
   where (kind = 'wave' and at < now() - interval '5 minutes')
      or (kind in ('warm', 'check_in') and at < now() - interval '2 hours')
      or at < now() - interval '2 days';
  delete from echoes where last_seen < now() - interval '3 days';
$$;

select cron.unschedule('one-sky-prune');
select cron.schedule('one-sky-prune', '*/10 * * * *', $$select public._prune()$$);
-- Anonymous visitors that have not been created in the last 30 days lose their identity.
select cron.schedule('one-sky-prune-anon', '23 4 * * *',
  $$delete from auth.users where is_anonymous and created_at < now() - interval '30 days'$$);

-- ───────────────────────────── privileges ─────────────────────────────

-- Pin the search path of every function in the schema (pg_temp last, so a temp object can never
-- shadow a table or function a SECURITY DEFINER body refers to).
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
              and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = public, pg_temp', f);
  end loop;
end $$;

-- Future functions are not exposed until granted. The per-schema statement removes Supabase's
-- default grant to the API roles; EXECUTE for PUBLIC is a built-in global default that a per-schema
-- statement cannot take away, so that one is revoked for this role globally.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges revoke execute on functions from public;

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.check_in(real, real, text, text, int),
  public.release_lantern(text, int, real, real, text, text),
  public.warm_lantern(uuid),
  public.report_lantern(uuid),
  public.send_wave(uuid, real, real, text, text),
  public.recent_echoes(),
  public.world_stats(),
  public.my_marks()
to anon, authenticated;

notify pgrst, 'reload schema';
