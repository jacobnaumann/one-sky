-- Rewrites the six welcome lanterns: the card already says "A lantern from One Sky",
-- so the prefix was redundant, and two lines claimed things that are not always true.
update public.lanterns set body = 'Welcome. Whoever you are, this is your sky too.' where seeded and place = 'Reykjavik';
update public.lanterns set body = 'Somewhere it is breakfast and somewhere it is midnight, and both are on this page.' where seeded and place = 'Nairobi';
update public.lanterns set body = 'When two people wave back at each other, a thread of light stays between them.' where seeded and place = 'Valparaíso';
update public.lanterns set body = 'Nobody here has a name, only a place. Be kind to the places.' where seeded and place = 'Lisbon';
update public.lanterns set body = 'A lantern is a short note left for strangers. Leave one; it drifts for two days.' where seeded and place = 'Kyoto';
update public.lanterns set body = 'The day starts here. Help light all twenty-four hours of it.' where seeded and place = 'Auckland';
