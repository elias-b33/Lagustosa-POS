package se.restaurant.nativepos;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class Json {
  private Json() {}

  public static JSONObject object(String text) {
    try {
      return new JSONObject(text);
    } catch (JSONException e) {
      throw new IllegalArgumentException("Ogiltigt JSON-underlag", e);
    }
  }

  public static JSONObject obj(Object... pairs) {
    JSONObject o = new JSONObject();
    try {
      for (int i = 0; i < pairs.length; i += 2)
        o.put((String) pairs[i], pairs[i + 1] == null ? JSONObject.NULL : pairs[i + 1]);
    } catch (JSONException e) {
      throw new IllegalArgumentException(e);
    }
    return o;
  }

  public static JSONObject copy(JSONObject o) {
    return object(o.toString());
  }

  public static void put(JSONObject o, String key, Object value) {
    try {
      o.put(key, value == null ? JSONObject.NULL : value);
    } catch (JSONException e) {
      throw new IllegalArgumentException(e);
    }
  }

  public static JSONObject child(JSONObject o, String key) {
    JSONObject c = o == null ? null : o.optJSONObject(key);
    return c == null ? new JSONObject() : c;
  }

  public static List<JSONObject> list(JSONObject o, String key) {
    return list(o == null ? null : o.optJSONArray(key));
  }

  public static List<JSONObject> list(JSONArray a) {
    List<JSONObject> result = new ArrayList<>();
    if (a != null)
      for (int i = 0; i < a.length(); i++) {
        JSONObject o = a.optJSONObject(i);
        if (o != null) result.add(o);
      }
    return result;
  }

  public static JSONObject find(List<JSONObject> rows, String id) {
    for (JSONObject row : rows) if (row.optString("id").equals(id)) return row;
    return null;
  }

  public static String s(JSONObject o, String key) {
    return o == null || o.isNull(key) ? "" : o.optString(key, "");
  }

  public static String id(JSONObject o) {
    return s(o, "id");
  }
}
