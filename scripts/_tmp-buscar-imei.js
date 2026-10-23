#!/usr/bin/env node
'use strict';
// Script temporal de un solo uso -- buscar un IMEI en la tabla Tracklink
// para onboarding manual de un vehiculo nuevo. Borrar despues de usarlo.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://lomkolhgmkvshucqjuhf.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

(async () => {
  const imei = process.argv[2];
  const { data, error } = await supabase.from('Tracklink').select('*').eq('IMEI', imei);
  if (error) { console.error(error); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));

  const { data: existente, error: errExistente } = await supabase
    .from('porticos_vehiculos')
    .select('*')
    .eq('imei', imei);
  if (errExistente) { console.error(errExistente); process.exit(1); }
  console.log('Ya en porticos_vehiculos:', JSON.stringify(existente, null, 2));
})();
