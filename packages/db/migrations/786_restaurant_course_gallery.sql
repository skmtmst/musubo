ALTER TABLE rt_menu_items ADD COLUMN photo_gallery_json TEXT
  CHECK (photo_gallery_json IS NULL OR (json_valid(photo_gallery_json)
    AND json_type(photo_gallery_json) = 'array' AND json_array_length(photo_gallery_json) <= 5));
