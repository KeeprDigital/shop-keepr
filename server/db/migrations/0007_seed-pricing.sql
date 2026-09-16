-- The Store's Pricing Rules (spec §6, _Store settings_; ADR 0004): every
-- Store-scope setting the evaluator resolves to, as shared/pricing/settings.ts
-- SEEDED_STORE_SETTINGS declares them (a db test holds the two equal). Fixed
-- by ticket: neutral Stock and Quantity Bands, Default Tender cash, Tender
-- Modifier 0. The rest is the prototype's demo until the store sets its own.
INSERT INTO `pricing_setting` (`store_id`, `scope`, `side`, `key`, `value`, `updated_at`)
VALUES
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'sell', 'valueBands', '[{"from":0,"pct":100,"f":0},{"from":1000,"pct":105,"f":0},{"from":5000,"pct":110,"f":0}]', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'sell', 'condition', '{"NM":{"k":1,"f":0},"LP":{"k":0.85,"f":0},"MP":{"k":0.7,"f":0},"HP":{"k":0.5,"f":0},"DMG":{"k":0.3,"f":0}}', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'sell', 'language', '{"en":{"k":1,"f":0},"ja":{"k":0.9,"f":0},"de":{"k":0.8,"f":0},"fr":{"k":0.8,"f":0},"it":{"k":0.8,"f":0}}', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'sell', 'floor', '25', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'sell', 'rounding', '{"inc":10,"dir":"up"}', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'sell', 'steps', '["fx","condition","language","percentage","attributes","round","floor"]', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'buy', 'valueBands', '[{"from":0,"pct":50,"f":0},{"from":500,"pct":60,"f":0},{"from":2000,"pct":65,"f":0}]', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'buy', 'condition', '{"NM":{"k":1,"f":0},"LP":{"k":0.8,"f":0},"MP":{"k":0.6,"f":0},"HP":{"k":0.4,"f":0},"DMG":{"k":0.2,"f":0}}', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'buy', 'language', '{"en":{"k":1,"f":0},"ja":{"k":0.8,"f":0},"de":{"k":0.7,"f":0},"fr":{"k":0.7,"f":0},"it":{"k":0.7,"f":0}}', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'buy', 'stockBands', '[{"from":0,"k":1,"f":0}]', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'buy', 'qtyBands', '[{"from":1,"k":1,"f":0}]', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'buy', 'floor', '5', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'buy', 'rounding', '{"inc":5,"dir":"down"}', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'buy', 'tender', '{"def":"cash","mod":0}', 1789084800000),
('01M27ESJJBX2CDFG9KM5SZT3SY', 'store', 'buy', 'steps', '["fx","condition","language","percentage","stock","quantity","attributes","round","floor"]', 1789084800000);
