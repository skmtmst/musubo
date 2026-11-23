ALTER TABLE rt_reservations ADD COLUMN allergies_json TEXT CHECK(allergies_json IS NULL OR json_valid(allergies_json));
CREATE TRIGGER rt_reservation_allergies_legacy_update AFTER UPDATE OF allergy_note ON rt_reservations WHEN NEW.allergy_note IS NOT OLD.allergy_note AND NEW.allergies_json IS OLD.allergies_json BEGIN UPDATE rt_reservations SET allergies_json = NULL WHERE id = NEW.id; END;
