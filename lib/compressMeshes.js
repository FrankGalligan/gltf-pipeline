'use strict';
var Cesium = require('cesium');
var hashObject = require('object-hash');
var ForEach = require('./ForEach');
var readAccessor = require('./readAccessor');
var numberOfComponentsForType = require('./numberOfComponentsForType');
var addExtensionsRequired = require('./addExtensionsRequired');
var addExtensionsUsed = require('./addExtensionsUsed');
var packArray = require('./packArray');
var addToArray = require('./addToArray');
var RemoveUnusedProperties = require('./RemoveUnusedProperties');

var defined = Cesium.defined;
var arrayFill = Cesium.arrayFill;

var removeBufferViews = RemoveUnusedProperties.removeBufferViews;
var removeBuffers = RemoveUnusedProperties.removeBuffers;
var removeAccessors = RemoveUnusedProperties.removeAccessors;
// Prepare encoder for compressing meshes.
var draco3d = require('draco3d');
var encoderModule = draco3d.createEncoderModule({});

module.exports = compressMeshes;

function getNamedAttributeData(gltf, primitive, semantic) {
    var accessorId = primitive.attributes[semantic];
    var accessor = gltf.accessors[accessorId];
    var componentsPerAttribute = numberOfComponentsForType(accessor.type);
    var values = [];
    var type = readAccessor(gltf, accessor, values);
    var packed = packArray(values, type);
    return {
      numComponents : componentsPerAttribute,
      numVertices : accessor.count,
      data : packed
    };
}

function addCompressionExtensionToPrimitive(gltf, primitive,
    attributeToId, encodedLen, encodedData) {
    // Remove properties from accessors.
    // Remove indices bufferView.

    var indicesAccessor = gltf.accessors[primitive.indices];
    var newIndicesAccessor = {
          componentType : indicesAccessor.componentType,
          count : indicesAccessor.count,
          max : indicesAccessor.max,
          min : indicesAccessor.min,
          type : indicesAccessor.type
    };
    var indicesAccessorId = addToArray(gltf.accessors, newIndicesAccessor);
    primitive.indices = indicesAccessorId;

    // Remove attributes bufferViews.
    for (var semantic in primitive.attributes) {
      var attributeAccessor = gltf.accessors[primitive.attributes[semantic]];
      var newAttributeAccessor = {
          componentType : attributeAccessor.componentType,
          count : attributeAccessor.count,
          max : attributeAccessor.max,
          min : attributeAccessor.min,
          type : attributeAccessor.type
      };
      var attributeAccessorId = addToArray(gltf.accessors, newAttributeAccessor);
      primitive.attributes[semantic] = attributeAccessorId;
    }

    var buffer = {
        byteLength : encodedLen,
        extras : {
            _pipeline : {
                extension : '.bin',
                source :encodedData 
            }
        }
    };
    var bufferId = addToArray(gltf.buffers, buffer);
    var bufferView = {
        buffer : bufferId,
        byteOffset : 0,
        byteLength : encodedLen
    };
    var bufferViewId = addToArray(gltf.bufferViews, bufferView);

    var extensions = primitive.extensions;
    if (!defined(primitive.extensions)) {
      extensions = {};
      primitive.extensions = extensions;
    }
    var draco_extension = {
      bufferView : bufferViewId,
      attributes : attributeToId, 
    };
    extensions.KHR_draco_mesh_compression = draco_extension;
}

function copyCompressedExtensionToPrimitive(primitive, compressedPrimitive) {
  var attributes = {};
  for (var semantic in primitive.attributes) {
    attributes[semantic] = compressedPrimitive.attributes[semantic];
  }
  primitive.attributes = attributes;
  primitive.indices = compressedPrimitive.indices;

  var draco_extension = compressedPrimitive.extensions.KHR_draco_mesh_compression
  var extensions = {};
  primitive.extensions = extensions;
  var copied_extension = {
      bufferView : draco_extension.bufferView,
      attributes : draco_extension.attributes, 
  };
  extensions.KHR_draco_mesh_compression = copied_extension;
}

function compressMeshes(gltf, options) {
    addExtensionsRequired(gltf, 'KHR_draco_mesh_compression');
    var hashPrimitives = [];
    options = options === undefined ? {} : options;
    var positionQuantization = !defined(options.quantizePosition) ? 14 : options.quantizePosition;
    var normalQuantization = options.quantizeNormal === undefined ? 12 : options.quantizeNormal;
    var texcoordQuantization = options.quantizeTexcoord === undefined ? 12 : options.quantizeTexcoord;
    var colorQuantization = options.quantizeColor === undefined ? 8 : options.quantizeColor;
    var skinQuantization = options.quantizeSkin === undefined ? 12 : options.quantizeSkin;
    var useUnifiedQuantization = options.unifiedQuantization === undefined ? false : options.unifiedQuantization;
    var positionOrigin, positionRange;

    if (useUnifiedQuantization) {
      // Collect bounding box from all primitives. Currently works only for vec3 positions (XYZ).
      var accessors = gltf.accessors;
      var min = arrayFill(new Array(3), Number.POSITIVE_INFINITY);
      var max = arrayFill(new Array(3), Number.NEGATIVE_INFINITY);
      ForEach.accessorWithSemantic(gltf, "POSITION", function(accessorId, attributeSemantic, primitive) {
          var accessor = accessors[accessorId];
          if (accessor.type !== 'VEC3') {
            console.log("Couldn't perform unified quantization. Input contains position accessor with an unsupported number of components.");
            useUnifiedQuantization = false;
            return;
          }
          var accessorMin = accessor.min;
          var accessorMax = accessor.max;
          for (var j = 0; j < 3; ++j) {
            min[j] = Math.min(min[j], accessorMin[j]);
            max[j] = Math.max(max[j], accessorMax[j]);
          }
      });
      positionOrigin = min;
      positionRange = Math.max(max[0] - min[0], Math.max(max[1] - min[1], max[2] - min[2]));
    }

    ForEach.mesh(gltf, function(mesh) {
        ForEach.meshPrimitive(mesh, function(primitive, primitiveId) {
            var primitiveType = primitive.mode;
            // Only support triangles now.
            if (defined(primitive.mode) && primitive.mode !== 4) {
              console.log("Skipped primitive. Unsupported primitive mode.");
              return;
            }

            // TODO: Use hash map.
            var primitiveGeometry = {
              attributes : primitive.attributes,
              indices : primitive.indices,
              mode : primitive.mode
            };
            var hashValue = hashObject(primitiveGeometry);
            if (hashPrimitives[hashValue] !== undefined) {
              console.log('Found duplicate!');
              // Copy compressed primitive.
              copyCompressedExtensionToPrimitive(
                  primitive, hashPrimitives[hashValue]);
              return;
            } else {
              hashPrimitives[hashValue] = primitive;
            }

            const encoder = new encoderModule.Encoder();
            const meshBuilder = new encoderModule.MeshBuilder();
            const newMesh = new encoderModule.Mesh();

            // First get the faces and add to geometry.
            var indicesData = [];
            readAccessor(gltf, gltf.accessors[primitive.indices], indicesData);
            const indices = new Uint32Array(indicesData);
            const numFaces = indices.length / 3;
            const numIndices = indices.length;

            console.log("Num of faces: " + numFaces);
            meshBuilder.AddFacesToMesh(newMesh, numFaces, indices);

            // Add attributes to mesh.
            var attributes = primitive.attributes;
            var attributeToId = {};
            for (var semantic in attributes) {
                const attributeData = getNamedAttributeData(gltf, primitive, semantic);
                const numPoints = attributeData.numVertices;
                var attributeName = semantic;
                if (semantic.indexOf('_') !== -1)
                  attributeName = attributeName.substring(0, semantic.indexOf('_'));

                const data = new Float32Array(attributeData.data);
                var attributeId = -1;
                if (attributeName === 'POSITION' || attributeName === 'NORMAL' ||
                    attributeName === 'COLOR' ) {
                  attributeId = meshBuilder.AddFloatAttributeToMesh(newMesh, encoderModule[attributeName],
                      numPoints, attributeData.numComponents, data);
                } else if (semantic === 'TEXCOORD_0') {
                  attributeId = meshBuilder.AddFloatAttributeToMesh(newMesh, encoderModule.TEX_COORD,
                      numPoints, attributeData.numComponents, data);
                } else {
                  attributeId = meshBuilder.AddFloatAttributeToMesh(newMesh, encoderModule.GENERIC,
                      numPoints, attributeData.numComponents, data);
                }

                if (attributeId === -1) {
                  console.log("Error: Failed adding attribute " + semantic);
                  return;
                } else {
                  attributeToId[semantic] = attributeId;
                }
            }

            let encodedDracoDataArray = new encoderModule.DracoInt8Array();
            encoder.SetSpeedOptions(5, 5);
            if (useUnifiedQuantization) {
              encoder.SetAttributeExplicitQuantization(encoderModule.POSITION, positionQuantization, 3, positionOrigin, positionRange);
            } else {
              encoder.SetAttributeQuantization(encoderModule.POSITION, positionQuantization);
            }
            encoder.SetAttributeQuantization(encoderModule.NORMAL, normalQuantization);
            encoder.SetAttributeQuantization(encoderModule.TEX_COORD, texcoordQuantization);
            encoder.SetAttributeQuantization(encoderModule.COLOR, colorQuantization);
            encoder.SetAttributeQuantization(encoderModule.GENERIC, skinQuantization);
            encoder.SetEncodingMethod(encoderModule.MESH_EDGEBREAKER_ENCODING);
  
            const encodedLen = encoder.EncodeMeshToDracoBuffer(newMesh, encodedDracoDataArray);
            if (encodedLen > 0) {
              console.log("Encoded size is " + encodedLen);
            } else {
              console.log("Error: Encoding failed.");
            }
            var encodedData = new Buffer(encodedLen);
            for (var i = 0; i < encodedLen; i++) {
              encodedData[i] = encodedDracoDataArray.GetValue(i);
            }

            addCompressionExtensionToPrimitive(gltf, primitive,
                attributeToId, encodedLen, encodedData);
        });
    });
    removeAccessors(gltf);
    removeBufferViews(gltf);
    removeBuffers(gltf);
    return gltf;
}
